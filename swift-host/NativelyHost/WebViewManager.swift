// swift-host/NativelyHost/WebViewManager.swift

import AppKit
import WebKit

protocol WebViewManagerDelegate: AnyObject {
    func webViewManager(_ manager: WebViewManager, didReceiveMessage channel: String, data: Any?)
    func webViewManager(_ manager: WebViewManager, didInvoke channel: String, data: Any?, replyHandler: @escaping (Any?) -> Void)
}

class WebViewManager: NSObject {
    weak var delegate: WebViewManagerDelegate?
    
    private(set) var webView: WKWebView!
    private var pendingInvocations: [String: (Any?) -> Void] = [:]
    
    override init() {
        super.init()
        setupWebView()
    }
    
    private func setupWebView() {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        
        // Setup user content controller for IPC
        let contentController = WKUserContentController()
        
        // Inject electronAPI bridge
        let bridgeScript = WKUserScript(
            source: Self.bridgeJavaScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(bridgeScript)
        
        // Register message handler
        contentController.add(self, name: "ipc")
        
        config.userContentController = contentController
        
        // Create webview
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
    }
    
    func loadApp(from url: URL) {
        webView.load(URLRequest(url: url))
    }
    
    func loadLocalApp() {
        // Load from bundled dist/index.html
        if let distPath = Bundle.main.path(forResource: "dist/index", ofType: "html") {
            let url = URL(fileURLWithPath: distPath)
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            // Development: load from Vite dev server
            loadApp(from: URL(string: "http://localhost:5173")!)
        }
    }
    
    /// Send event to webview
    func sendEvent(_ channel: String, data: Any?) {
        let jsonData: String
        if let data = data {
            if let jsonBytes = try? JSONSerialization.data(withJSONObject: data),
               let jsonString = String(data: jsonBytes, encoding: .utf8) {
                jsonData = jsonString
            } else {
                jsonData = "null"
            }
        } else {
            jsonData = "null"
        }
        
        let js = "window.__ipcReceive('\(channel)', \(jsonData))"
        webView.evaluateJavaScript(js) { _, error in
            if let error = error {
                print("WebViewManager: Failed to send event: \(error)")
            }
        }
    }
    
    /// Resolve a pending invoke
    func resolveInvoke(id: String, result: Any?) {
        let jsonData: String
        if let result = result {
            if let jsonBytes = try? JSONSerialization.data(withJSONObject: result),
               let jsonString = String(data: jsonBytes, encoding: .utf8) {
                jsonData = jsonString
            } else {
                jsonData = "null"
            }
        } else {
            jsonData = "null"
        }
        
        let js = "window.__ipcResolve('\(id)', \(jsonData))"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }
    
    /// Reject a pending invoke with error
    func rejectInvoke(id: String, error: String) {
        let escapedError = error.replacingOccurrences(of: "'", with: "\\'")
        let js = "window.__ipcReject('\(id)', '\(escapedError)')"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }
    
    // MARK: - Bridge JavaScript
    
    private static let bridgeJavaScript = """
    (function() {
        // Pending invocations waiting for response
        window.__pendingInvokes = {};
        
        // Event listeners
        window.__ipcListeners = {};
        
        // Receive event from native
        window.__ipcReceive = function(channel, data) {
            const listeners = window.__ipcListeners[channel] || [];
            listeners.forEach(function(callback) {
                try {
                    callback(data);
                } catch (e) {
                    console.error('IPC listener error:', e);
                }
            });
        };
        
        // Resolve pending invoke
        window.__ipcResolve = function(id, result) {
            const pending = window.__pendingInvokes[id];
            if (pending) {
                pending.resolve(result);
                delete window.__pendingInvokes[id];
            }
        };
        
        // Reject pending invoke
        window.__ipcReject = function(id, error) {
            const pending = window.__pendingInvokes[id];
            if (pending) {
                pending.reject(new Error(error));
                delete window.__pendingInvokes[id];
            }
        };
        
        // Electron-compatible API
        window.electronAPI = {
            // Send without expecting response
            send: function(channel, data) {
                window.webkit.messageHandlers.ipc.postMessage({
                    type: 'send',
                    channel: channel,
                    data: data
                });
            },
            
            // Invoke and wait for response
            invoke: function(channel, data) {
                return new Promise(function(resolve, reject) {
                    const id = Math.random().toString(36).substring(2);
                    window.__pendingInvokes[id] = { resolve: resolve, reject: reject };
                    
                    window.webkit.messageHandlers.ipc.postMessage({
                        type: 'invoke',
                        id: id,
                        channel: channel,
                        data: data
                    });
                    
                    // Timeout after 30 seconds
                    setTimeout(function() {
                        if (window.__pendingInvokes[id]) {
                            reject(new Error('IPC invoke timeout'));
                            delete window.__pendingInvokes[id];
                        }
                    }, 30000);
                });
            },
            
            // Listen for events
            on: function(channel, callback) {
                if (!window.__ipcListeners[channel]) {
                    window.__ipcListeners[channel] = [];
                }
                window.__ipcListeners[channel].push(callback);
                
                // Return unsubscribe function
                return function() {
                    const idx = window.__ipcListeners[channel].indexOf(callback);
                    if (idx >= 0) {
                        window.__ipcListeners[channel].splice(idx, 1);
                    }
                };
            },
            
            // Remove listener
            removeListener: function(channel, callback) {
                const listeners = window.__ipcListeners[channel];
                if (listeners) {
                    const idx = listeners.indexOf(callback);
                    if (idx >= 0) {
                        listeners.splice(idx, 1);
                    }
                }
            }
        };
        
        console.log('[NativelyHost] electronAPI bridge initialized');
    })();
    """
}

// MARK: - WKScriptMessageHandler

extension WebViewManager: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, 
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else {
            return
        }
        
        let channel = body["channel"] as? String ?? ""
        let data = body["data"]
        
        switch type {
        case "send":
            delegate?.webViewManager(self, didReceiveMessage: channel, data: data)
            
        case "invoke":
            guard let id = body["id"] as? String else { return }
            delegate?.webViewManager(self, didInvoke: channel, data: data) { [weak self] result in
                self?.resolveInvoke(id: id, result: result)
            }
            
        default:
            print("WebViewManager: Unknown message type: \(type)")
        }
    }
}

// MARK: - WKNavigationDelegate

extension WebViewManager: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("WebViewManager: Page loaded")
    }
    
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("WebViewManager: Navigation failed: \(error)")
    }
    
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("WebViewManager: Provisional navigation failed: \(error)")
    }
}
