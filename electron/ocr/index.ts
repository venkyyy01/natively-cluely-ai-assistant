import { OcrService, type OcrProvider } from './OcrService';
import { AppleVisionOcrProvider } from './providers/AppleVisionOcrProvider';
import { WindowsOcrProvider } from './providers/WindowsOcrProvider';
import { TesseractOcrProvider } from './providers/TesseractOcrProvider';

/**
 * Build a per-platform OCR cascade.
 *
 * Order is deliberate: native providers first (free, fast, ship with the
 * OS), Tesseract last (universal, slow). Providers above the cascade that
 * report `isAvailable() === false` are skipped without affecting the rest.
 */
export function createOcrService(): OcrService {
  const providers: OcrProvider[] = [];
  if (process.platform === 'darwin') {
    providers.push(new AppleVisionOcrProvider());
  }
  if (process.platform === 'win32') {
    providers.push(new WindowsOcrProvider());
  }
  providers.push(new TesseractOcrProvider());
  return new OcrService(providers);
}

export { OcrService, type OcrProvider } from './OcrService';
export type { OcrResult } from './OcrService';
