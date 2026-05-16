//! Native OCR providers.
//!
//! Exposes two napi functions to JS:
//!   * `recognize_text_macos(image_path)` — VNRecognizeTextRequest via the
//!     Apple Vision framework. Available on macOS 10.15+. Free, fast (~50ms
//!     per image), supports many languages.
//!   * `recognize_text_windows(image_path)` — Windows.Media.Ocr.OcrEngine via
//!     WinRT. Available on Windows 10/11. Free, fast (~80ms per image).
//!
//! Both APIs are gated by `#[cfg(target_os = …)]` so non-applicable platforms
//! get a graceful "unsupported" error from JS that the cascade resolver in TS
//! treats as "skip me, try the next provider".
//!
//! Errors are returned as `napi::Error` with a stable message format the TS
//! resolver can pattern-match (`Unsupported on this platform`, `Permission
//! denied`, `Image not readable`, etc).

#[cfg(target_os = "macos")]
mod macos_ocr {
    use cidre::{ns, vn};

    /// Recognize text in `image_path` using VNRecognizeTextRequest.
    ///
    /// Implementation:
    ///   1. Wrap path in `ns::Url::with_fs_path_str` so we don't depend on
    ///      where the renderer dropped the screenshot.
    ///   2. Build VNImageRequestHandler with no extra options.
    ///   3. Build VNRecognizeTextRequest in `Accurate` level with language
    ///      correction enabled.
    ///   4. Run the request synchronously on the calling thread (Vision is
    ///      thread-safe and Tokio-free; the JS side already calls this from
    ///      a worker via N-API tsfn).
    ///   5. Pull the top candidate from each observation; join with newlines.
    ///
    /// Returns `Ok("")` if the image had no recognizable text — TS resolver
    /// treats empty results as "fell through to next provider".
    pub fn recognize_text(image_path: &str) -> napi::Result<String> {
        // ns::Url constructors expect a file:// URL or a fs path. Use the
        // explicit fs-path constructor to avoid percent-escape pitfalls.
        let url = ns::Url::with_fs_path_str(image_path, false);

        let handler = vn::ImageRequestHandler::with_url(&url, None);

        let mut request = vn::RecognizeTextRequest::new();
        request.set_recognition_level(vn::RequestTextRecognitionLevel::Accurate);
        request.set_uses_lang_correction(true);

        // Build a single-element ns::Array of vn::Request from our concrete
        // RecognizeTextRequest. cidre's `as_ref` produces a &Request view.
        let request_ref: &vn::Request = request.as_ref();
        let requests = ns::Array::<vn::Request>::from_slice(&[request_ref]);

        if let Err(err) = handler.perform(&requests) {
            return Err(napi::Error::from_reason(format!(
                "VNImageRequestHandler.perform failed: {}",
                err.localized_desc()
            )));
        }

        let observations = match request.results() {
            Some(obs) => obs,
            None => return Ok(String::new()),
        };

        let mut lines: Vec<String> = Vec::with_capacity(observations.len());
        for observation in observations.iter() {
            let candidates = observation.top_candidates(1);
            if candidates.is_empty() {
                continue;
            }
            let top = match candidates.get(0) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let text = top.string().to_string();
            if !text.is_empty() {
                lines.push(text);
            }
        }

        Ok(lines.join("\n"))
    }
}

#[cfg(not(target_os = "macos"))]
mod macos_ocr {
    pub fn recognize_text(_image_path: &str) -> napi::Result<String> {
        Err(napi::Error::from_reason(
            "Unsupported on this platform".to_string(),
        ))
    }
}

#[cfg(target_os = "windows")]
mod windows_ocr {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    /// Recognize text in `image_path` using Windows.Media.Ocr.OcrEngine.
    ///
    /// The OcrEngine selects a recognition language from the system's
    /// `available_recognizer_languages` list; we use the user's primary
    /// language when supported, otherwise fall back to en-US, otherwise
    /// any available language.
    pub fn recognize_text(image_path: &str) -> napi::Result<String> {
        // 1. Open the image as a StorageFile.
        let path_h: HSTRING = image_path.into();
        let file_op = StorageFile::GetFileFromPathAsync(&path_h)
            .map_err(|e| napi::Error::from_reason(format!("StorageFile open failed: {}", e)))?;
        let file = file_op
            .get()
            .map_err(|e| napi::Error::from_reason(format!("StorageFile.get failed: {}", e)))?;

        let stream_op = file
            .OpenAsync(FileAccessMode::Read)
            .map_err(|e| napi::Error::from_reason(format!("File.OpenAsync failed: {}", e)))?;
        let stream = stream_op
            .get()
            .map_err(|e| napi::Error::from_reason(format!("File stream get failed: {}", e)))?;

        // 2. Decode into a SoftwareBitmap.
        let decoder_op = BitmapDecoder::CreateAsync(&stream)
            .map_err(|e| napi::Error::from_reason(format!("BitmapDecoder create failed: {}", e)))?;
        let decoder = decoder_op
            .get()
            .map_err(|e| napi::Error::from_reason(format!("BitmapDecoder get failed: {}", e)))?;

        let bitmap_op = decoder
            .GetSoftwareBitmapAsync()
            .map_err(|e| napi::Error::from_reason(format!("GetSoftwareBitmap failed: {}", e)))?;
        let bitmap = bitmap_op
            .get()
            .map_err(|e| napi::Error::from_reason(format!("SoftwareBitmap get failed: {}", e)))?;

        // 3. Pick an OCR engine. Try user profile language → en-US → first available.
        let engine = pick_engine().ok_or_else(|| {
            napi::Error::from_reason(
                "Windows OCR has no installed recognition language".to_string(),
            )
        })?;

        // 4. Run OCR.
        let result_op = engine
            .RecognizeAsync(&bitmap)
            .map_err(|e| napi::Error::from_reason(format!("OCR RecognizeAsync failed: {}", e)))?;
        let result = result_op
            .get()
            .map_err(|e| napi::Error::from_reason(format!("OCR result get failed: {}", e)))?;

        let text = result
            .Text()
            .map_err(|e| napi::Error::from_reason(format!("OCR Text() failed: {}", e)))?;

        Ok(text.to_string_lossy())
    }

    fn pick_engine() -> Option<OcrEngine> {
        // 1. Try the user's profile language.
        if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
            return Some(engine);
        }

        // 2. Fall back to en-US explicitly.
        if let Ok(en) = Language::CreateLanguage(&HSTRING::from("en-US")) {
            if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&en) {
                return Some(engine);
            }
        }

        // 3. Fall back to the first available recognizer language.
        if let Ok(langs) = OcrEngine::AvailableRecognizerLanguages() {
            if let Ok(first) = langs.GetAt(0) {
                if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&first) {
                    return Some(engine);
                }
            }
        }

        None
    }
}

#[cfg(not(target_os = "windows"))]
mod windows_ocr {
    pub fn recognize_text(_image_path: &str) -> napi::Result<String> {
        Err(napi::Error::from_reason(
            "Unsupported on this platform".to_string(),
        ))
    }
}

/// Run Apple Vision OCR on the image at `image_path`.
///
/// Returns the recognized text as a single string with newline-separated
/// lines, ordered top-to-bottom as Vision reports them. Returns an empty
/// string when no text is found. Errors include the literal phrase
/// "Unsupported on this platform" on non-macOS so the TS-side cascade
/// can pattern-match and skip cleanly without logging at warn level.
#[napi]
pub fn recognize_text_macos(image_path: String) -> napi::Result<String> {
    macos_ocr::recognize_text(&image_path)
}

/// Run Windows.Media.Ocr on the image at `image_path`.
///
/// Same contract as `recognize_text_macos`. Errors with "Unsupported on this
/// platform" on non-Windows so the cascade falls through to the next
/// provider (Tesseract) cleanly.
#[napi]
pub fn recognize_text_windows(image_path: String) -> napi::Result<String> {
    windows_ocr::recognize_text(&image_path)
}
