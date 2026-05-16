// ScreenshotHelper.ts

import path from "node:path"
import fs from "node:fs"
import { app } from "electron"
import { v4 as uuidv4 } from "uuid"
import { exec as cpExec } from "node:child_process"
export class ScreenshotHelper {
  private screenshotQueue: string[] = []
  private extraScreenshotQueue: string[] = []
  private readonly MAX_SCREENSHOTS = 5
  private readonly MAX_FILE_BYTES = 10 * 1024 * 1024
  private queueOp: Promise<void> = Promise.resolve()

  private readonly screenshotDir: string
  private readonly extraScreenshotDir: string

  private view: "queue" | "solutions" = "queue"

  constructor(view: "queue" | "solutions" = "queue") {
    this.view = view

    // Initialize directories
    this.screenshotDir = path.join(app.getPath("userData"), "screenshots")
    this.extraScreenshotDir = path.join(
      app.getPath("userData"),
      "extra_screenshots"
    )

    // Create directories if they don't exist
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true })
    }
    if (!fs.existsSync(this.extraScreenshotDir)) {
      fs.mkdirSync(this.extraScreenshotDir, { recursive: true })
    }
  }

  private readonly SCREENSHOT_TIMEOUT_MS = 30000

  private async waitForWindowHide(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, process.platform === 'darwin' ? 180 : 120))
  }

  private execWithKillOnTimeout(cmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = cpExec(cmd, (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore kill errors */ }
        reject(new Error(`Screenshot timed out after ${this.SCREENSHOT_TIMEOUT_MS}ms`))
      }, this.SCREENSHOT_TIMEOUT_MS)
      child.on('exit', () => clearTimeout(timer))
    })
  }

  private async withQueueLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queueOp
    let release!: () => void
    this.queueOp = new Promise<void>(resolve => {
      release = resolve
    })

    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async trimQueue(queue: string[]): Promise<void> {
    await this.withQueueLock(async () => {
      while (queue.length > this.MAX_SCREENSHOTS) {
        const removedPath = queue.shift()
        if (!removedPath) continue
        try {
          await fs.promises.unlink(removedPath)
        } catch (error) {
          console.error("Error removing old screenshot:", error)
        }
      }
    })
  }

  private async enforceFileSizeLimit(screenshotPath: string): Promise<void> {
    const stats = await fs.promises.stat(screenshotPath)
    if (stats.size > this.MAX_FILE_BYTES) {
      await fs.promises.unlink(screenshotPath)
      throw new Error(`Screenshot exceeds ${this.MAX_FILE_BYTES} byte limit`)
    }
  }

  /**
   * Platform-aware screenshot command builder.
   * Supports macOS (screencapture), Linux (gnome-screenshot/scrot/import), and Windows (PowerShell).
   */
  private getScreenshotCommand(outputPath: string, interactive: boolean): string {
    // Safety: outputPath must be within our controlled directories.
    // Since we always construct paths using path.join(this.screenshotDir, uuidv4()),
    // this assertion guards against any future regression where external input could reach here.
    const userDataDir = app.getPath('userData');
    if (!outputPath.startsWith(userDataDir)) {
      throw new Error(`[ScreenshotHelper] Refusing shell command for path outside userData: ${outputPath}`);
    }
    // Escape double-quotes within the path as a defense-in-depth measure
    const safePath = outputPath.replace(/"/g, '\\"');
    const platform = process.platform;
    if (platform === 'darwin') {
      return interactive
        ? `screencapture -i -x "${safePath}"`
        : `screencapture -x -C "${safePath}"`;
    } else if (platform === 'linux') {
      return interactive
        ? `gnome-screenshot -a -f "${safePath}" 2>/dev/null || scrot -s "${safePath}" 2>/dev/null || import "${safePath}"`
        : `gnome-screenshot -f "${safePath}" 2>/dev/null || scrot "${safePath}" 2>/dev/null || import -window root "${safePath}"`;
    } else if (platform === 'win32') {
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; $b = [System.Drawing.Bitmap]::new([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0,0,0,0,$b.Size); $b.Save('${safePath.replace(/'/g, "''")}'); $g.Dispose(); $b.Dispose()`;
      return `powershell -NoProfile -Command "${psScript}"`;
    }
    throw new Error(`Unsupported platform for screenshots: ${platform}`);
  }

  public getView(): "queue" | "solutions" {
    return this.view
  }

  public setView(view: "queue" | "solutions"): void {
    this.view = view
  }

  public getScreenshotQueue(): string[] {
    return this.screenshotQueue
  }

  public getExtraScreenshotQueue(): string[] {
    return this.extraScreenshotQueue
  }

  public clearQueues(): void {
    // Snapshot queue contents synchronously, then reset queues immediately so
    // a concurrent takeScreenshot can't push into the array we are about to
    // unlink. This is race-safe because JS is single-threaded — between the
    // snapshot and reset there is no async point.
    const toUnlink = [...this.screenshotQueue, ...this.extraScreenshotQueue];
    this.screenshotQueue = [];
    this.extraScreenshotQueue = [];
    for (const screenshotPath of toUnlink) {
      fs.unlink(screenshotPath, (_err) => {
        // best-effort; file may already be gone or held by reader
      });
    }
  }

  public async takeScreenshot(
    hideMainWindow: () => void,
    showMainWindow: () => void
  ): Promise<string> {
    try {
      hideMainWindow()

      await this.waitForWindowHide()

      let screenshotPath = ""

      if (this.view === "queue") {
        screenshotPath = path.join(this.screenshotDir, `${uuidv4()}.png`)
        // Use native screencapture for reliability on macOS
        // -x: do not play sound
        // -C: capture cursor
        try {
          await this.execWithKillOnTimeout(this.getScreenshotCommand(screenshotPath, false))
        } catch (e: any) {
          if (e.message?.includes('timed out')) throw e
          const errorMsg = e.message || String(e)
          if (errorMsg.includes('could not create image') || errorMsg.includes('Screen Recording')) {
            throw new Error('Screen Recording permission denied. Please enable in System Settings > Privacy & Security > Screen Recording.')
          }
          throw e
        }
        await this.enforceFileSizeLimit(screenshotPath)

        this.screenshotQueue.push(screenshotPath)
        await this.trimQueue(this.screenshotQueue)
      } else {
        screenshotPath = path.join(this.extraScreenshotDir, `${uuidv4()}.png`)
        try {
          await this.execWithKillOnTimeout(this.getScreenshotCommand(screenshotPath, false))
        } catch (e: any) {
          if (e.message?.includes('timed out')) throw e
          const errorMsg = e.message || String(e)
          if (errorMsg.includes('could not create image') || errorMsg.includes('Screen Recording')) {
            throw new Error('Screen Recording permission denied. Please enable in System Settings > Privacy & Security > Screen Recording.')
          }
          throw e
        }
        await this.enforceFileSizeLimit(screenshotPath)

        this.extraScreenshotQueue.push(screenshotPath)
        await this.trimQueue(this.extraScreenshotQueue)
      }

      return screenshotPath
    } catch (error) {
      // console.error("Error taking screenshot:", error)
      throw new Error(`Failed to take screenshot: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // Ensure window is always shown again
      showMainWindow()
    }
  }

  public async takeSelectiveScreenshot(
    hideMainWindow: () => void,
    showMainWindow: () => void
  ): Promise<string> {
    try {
      hideMainWindow()

      await this.waitForWindowHide()

      let screenshotPath = ""

      // Always use the standard queue directory for this temporary context
      screenshotPath = path.join(this.screenshotDir, `selective-${uuidv4()}.png`)

      // -i: interactive mode (selection)
      // -x: do not play sound
      try {
        await this.execWithKillOnTimeout(this.getScreenshotCommand(screenshotPath, true))
      } catch (e: any) {
        if (e.message?.includes('timed out')) throw e
        const errorMsg = e.message || String(e)
        if (errorMsg.includes('could not create image') || errorMsg.includes('Screen Recording')) {
          throw new Error('Screen Recording permission denied. Please enable in System Settings > Privacy & Security > Screen Recording.')
        }
        throw new Error("Selection cancelled")
      }

      // Verify file exists (user might have pressed Esc)
      if (!fs.existsSync(screenshotPath)) {
        throw new Error("Selection cancelled")
      }

      await this.enforceFileSizeLimit(screenshotPath)

      this.screenshotQueue.push(screenshotPath)
      await this.trimQueue(this.screenshotQueue)

      return screenshotPath
    } catch (error) {
      throw error
    } finally {
      showMainWindow()
    }
  }

  public async getImagePreview(filepath: string): Promise<string> {
    const maxRetries = 20
    const delay = 250 // 5s total wait time

    for (let i = 0; i < maxRetries; i++) {
      try {
        if (fs.existsSync(filepath)) {
          // Double check file size is > 0
          const stats = await fs.promises.stat(filepath)
          if (stats.size > 0) {
            const data = await fs.promises.readFile(filepath)
            return `data:image/png;base64,${data.toString("base64")}`
          }
        }
      } catch (error) {
        // console.log(`[ScreenshotHelper] Retry ${i + 1}/${maxRetries} failed:`, error)
      }
      // Wait for file system
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    throw new Error(`Failed to read screenshot after ${maxRetries} retries (${maxRetries * delay}ms): ${filepath}`)
  }

  public async deleteScreenshot(
    path: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await fs.promises.unlink(path)
      // Scan both queues — this.view may have changed between push and delete,
      // and a path could legitimately exist in either bucket.
      this.screenshotQueue = this.screenshotQueue.filter(
        (filePath) => filePath !== path
      )
      this.extraScreenshotQueue = this.extraScreenshotQueue.filter(
        (filePath) => filePath !== path
      )
      return { success: true }
    } catch (error) {
      // console.error("Error deleting file:", error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
