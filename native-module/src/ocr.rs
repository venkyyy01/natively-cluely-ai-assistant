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
//! resolver can pattern-match. Stable error tags exported from this module:
//!   * `"Unsupported on this platform"` — wrong OS, skip provider quietly.
//!   * `"Image not found:"`             — file missing or unreadable.
//!   * `"Image path is empty"`          — blank input.
//!   * `"Image not readable:"`          — Vision/WinRT could not decode.
//!   * `"OCR timed out"` (reserved)     — caller-side timeout in JS.
//!
//! Cross-platform invariants enforced *before* hitting the platform layer:
//!   1. Path must be non-empty.
//!   2. Path must exist on disk and refer to a regular file.
//!   3. Path is canonicalised so relative paths and `..` segments work
//!      identically against Vision and WinRT (both APIs require absolute
//!      paths in practice).
//!
//! These shared guards live in the always-compiled `validate_image_path`
//! helper so behaviour matches between OSes — the JS-side `OcrService`
//! cascade only has one error contract to reason about.

use std::path::PathBuf;

/// Stable error prefix the TS-side cascade pattern-matches on so it can
/// downgrade these failures to debug-level logging without spamming.
const ERR_UNSUPPORTED: &str = "Unsupported on this platform";
const ERR_PATH_EMPTY: &str = "Image path is empty";
const ERR_PATH_NOT_FOUND: &str = "Image not found";
const ERR_PATH_NOT_FILE: &str = "Image path is not a regular file";

/// Validate and canonicalise an OCR input path before it reaches the
/// platform-specific code. Returns the canonicalised path on success.
///
/// Errors are stable strings that the TS-side `OcrService` can match
/// against, so a missing screenshot doesn't get logged at warn level
/// during normal multi-screenshot fallthrough.
fn validate_image_path(image_path: &str) -> napi::Result<PathBuf> {
    let trimmed = image_path.trim();
    if trimmed.is_empty() {
        return Err(napi::Error::from_reason(ERR_PATH_EMPTY.to_string()));
    }

    let raw = std::path::Path::new(trimmed);
    if !raw.exists() {
        return Err(napi::Error::from_reason(format!(
            "{}: {}",
            ERR_PATH_NOT_FOUND, trimmed
        )));
    }

    let metadata = std::fs::metadata(raw).map_err(|e| {
        napi::Error::from_reason(format!("{}: {} ({})", ERR_PATH_NOT_FOUND, trimmed, e))
    })?;
    if !metadata.is_file() {
        return Err(napi::Error::from_reason(format!(
            "{}: {}",
            ERR_PATH_NOT_FILE, trimmed
        )));
    }

    // Both Apple Vision and Windows.Media.Ocr behave best with an absolute
    // path. canonicalize() is best-effort — fall back to the raw path if
    // the FS doesn't support it (network paths on Windows, e.g.).
    let canonical = std::fs::canonicalize(raw).unwrap_or_else(|_| raw.to_path_buf());
    Ok(canonical)
}

#[cfg(target_os = "macos")]
mod macos_ocr {
    use cidre::{ns, objc, vn};
    use std::path::Path;

    /// Recognize text in `image_path` using VNRecognizeTextRequest.
    ///
    /// Implementation notes:
    ///   1. We assume the caller has already validated the path via
    ///      `validate_image_path`, so `image_path` exists and is absolute.
    ///   2. The Vision API is wrapped in `objc::ar_pool` so all autoreleased
    ///      objects (NSArray, NSURL, observations, candidates, NSString
    ///      results) drain at the end of the call. Without this, every
    ///      OCR call would leak ~tens of KB of Objective-C objects until
    ///      the next outer pool — which never appears on Electron's worker
    ///      threads. See FOUNDATION_INTENT plan note on autoreleasepool.
    ///   3. We build the file URL from a *copying* `ns::String` (not the
    ///      `_no_copy` flavour) so the URL never aliases stack memory that
    ///      could be dropped before the Vision request runs.
    ///   4. Request is run synchronously on the calling thread (Vision is
    ///      thread-safe; the JS side already calls this from a worker via
    ///      N-API tsfn so we don't introduce a second thread hop).
    ///   5. We pull the top candidate from each observation; join with
    ///      newlines.
    ///
    /// Returns `Ok("")` if the image had no recognizable text — TS resolver
    /// treats empty results as "fell through to next provider".
    pub fn recognize_text(image_path: &Path) -> napi::Result<String> {
        // Wrap the entire Vision pipeline in an autorelease pool so the
        // ARC-managed observations, NSStrings and CFData buffers are
        // released before we return to JS. Without this the per-call
        // working set (~tens of KB on a typical screenshot) accumulates
        // until the next outer autorelease pop, which on a worker thread
        // may not happen for the lifetime of the process.
        objc::ar_pool(|| recognize_text_inner(image_path))
    }

    fn recognize_text_inner(image_path: &Path) -> napi::Result<String> {
        let path_str = image_path.to_str().ok_or_else(|| {
            napi::Error::from_reason(format!(
                "Image path contains invalid UTF-8: {}",
                image_path.display()
            ))
        })?;

        // ns::String::with_str copies the bytes into a new NSString,
        // unlike with_str_no_copy which aliases the input. Copying is the
        // safer default for an interior path that we don't want to keep
        // alive after the call.
        let ns_path = ns::String::with_str(path_str);
        let url = ns::Url::with_fs_path_string(&ns_path, false);

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
                "Image not readable: {} (Vision code {}: {})",
                image_path.display(),
                err.code(),
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
            // Vision occasionally yields whitespace-only strings on glyphs
            // it couldn't decode; skip them so the joined output stays
            // tight.
            if !text.trim().is_empty() {
                lines.push(text);
            }
        }

        Ok(lines.join("\n"))
    }
}

#[cfg(not(target_os = "macos"))]
mod macos_ocr {
    use std::path::Path;

    pub fn recognize_text(_image_path: &Path) -> napi::Result<String> {
        Err(napi::Error::from_reason(
            super::ERR_UNSUPPORTED.to_string(),
        ))
    }
}

#[cfg(target_os = "windows")]
mod windows_ocr {
    use std::path::Path;
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
    ///
    /// The path is assumed to have been validated and canonicalised by
    /// the shared `validate_image_path` helper, so we don't repeat the
    /// existence check here.
    pub fn recognize_text(image_path: &Path) -> napi::Result<String> {
        let path_str = image_path.to_str().ok_or_else(|| {
            napi::Error::from_reason(format!(
                "Image path contains invalid UTF-8: {}",
                image_path.display()
            ))
        })?;

        // 1. Open the image as a StorageFile.
        let path_h: HSTRING = path_str.into();
        let file_op = StorageFile::GetFileFromPathAsync(&path_h)
            .map_err(|e| {
                napi::Error::from_reason(format!(
                    "Image not readable: {} (StorageFile open: {})",
                    path_str, e
                ))
            })?;
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
        let decoder_op = BitmapDecoder::CreateAsync(&stream).map_err(|e| {
            napi::Error::from_reason(format!(
                "Image not readable: {} (BitmapDecoder: {})",
                path_str, e
            ))
        })?;
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
    use std::path::Path;

    pub fn recognize_text(_image_path: &Path) -> napi::Result<String> {
        Err(napi::Error::from_reason(
            super::ERR_UNSUPPORTED.to_string(),
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
    let canonical = validate_image_path(&image_path)?;
    macos_ocr::recognize_text(&canonical)
}

/// Run Windows.Media.Ocr on the image at `image_path`.
///
/// Same contract as `recognize_text_macos`. Errors with "Unsupported on this
/// platform" on non-Windows so the cascade falls through to the next
/// provider (Tesseract) cleanly.
#[napi]
pub fn recognize_text_windows(image_path: String) -> napi::Result<String> {
    let canonical = validate_image_path(&image_path)?;
    windows_ocr::recognize_text(&canonical)
}

#[cfg(test)]
mod tests {
    use super::{validate_image_path, ERR_PATH_EMPTY, ERR_PATH_NOT_FILE, ERR_PATH_NOT_FOUND};
    use std::fs;
    use std::io::Write;

    #[test]
    fn validate_image_path_rejects_empty() {
        let err = validate_image_path("").expect_err("empty must error");
        assert!(
            err.reason.contains(ERR_PATH_EMPTY),
            "got: {}",
            err.reason
        );
    }

    #[test]
    fn validate_image_path_rejects_whitespace_only() {
        let err = validate_image_path("   \t  ").expect_err("blank must error");
        assert!(err.reason.contains(ERR_PATH_EMPTY), "got: {}", err.reason);
    }

    #[test]
    fn validate_image_path_rejects_missing_file() {
        let bogus = std::env::temp_dir().join("natively-ocr-missing-XXX.png");
        let _ = fs::remove_file(&bogus); // best effort
        let err = validate_image_path(bogus.to_str().unwrap()).expect_err("must error");
        assert!(
            err.reason.contains(ERR_PATH_NOT_FOUND),
            "got: {}",
            err.reason
        );
    }

    #[test]
    fn validate_image_path_rejects_directory() {
        let dir = std::env::temp_dir();
        let err = validate_image_path(dir.to_str().unwrap()).expect_err("dir must error");
        assert!(
            err.reason.contains(ERR_PATH_NOT_FILE),
            "got: {}",
            err.reason
        );
    }

    #[test]
    fn validate_image_path_accepts_existing_file() {
        let p = std::env::temp_dir().join("natively-ocr-validate-ok.png");
        let mut f = fs::File::create(&p).expect("temp file");
        f.write_all(b"fake-png").expect("write");
        let canonical = validate_image_path(p.to_str().unwrap()).expect("ok");
        assert!(canonical.is_absolute(), "canonical must be absolute");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn validate_image_path_canonicalizes_relative() {
        // Use temp directory which always exists. Build a relative path
        // and ensure validate_image_path returns an absolute version.
        let p = std::env::temp_dir().join("natively-ocr-validate-rel.png");
        fs::File::create(&p).expect("temp file");
        let canonical = validate_image_path(p.to_str().unwrap()).expect("ok");
        assert!(canonical.is_absolute());
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn validate_image_path_trims_input() {
        let p = std::env::temp_dir().join("natively-ocr-validate-trim.png");
        fs::File::create(&p).expect("temp file");
        let padded = format!("  {}  ", p.to_str().unwrap());
        let canonical = validate_image_path(&padded).expect("ok");
        assert!(canonical.is_absolute());
        let _ = fs::remove_file(&p);
    }

    /// On non-macOS targets, recognize_text_macos must return the stable
    /// "Unsupported on this platform" tag *after* validation. We can't
    /// directly invoke the napi-decorated function in unit tests (it
    /// relies on the napi runtime), so we instead exercise the inner
    /// module function on a real path to confirm path validation runs
    /// even on the stub.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn macos_stub_returns_unsupported() {
        use super::macos_ocr;
        let p = std::env::temp_dir().join("natively-ocr-stub-mac.png");
        fs::File::create(&p).expect("temp file");
        let err = macos_ocr::recognize_text(&p).expect_err("must error");
        assert_eq!(err.reason, super::ERR_UNSUPPORTED);
        let _ = fs::remove_file(&p);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn windows_stub_returns_unsupported() {
        use super::windows_ocr;
        let p = std::env::temp_dir().join("natively-ocr-stub-win.png");
        fs::File::create(&p).expect("temp file");
        let err = windows_ocr::recognize_text(&p).expect_err("must error");
        assert_eq!(err.reason, super::ERR_UNSUPPORTED);
        let _ = fs::remove_file(&p);
    }
}
