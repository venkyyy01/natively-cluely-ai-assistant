// node-backend/main.ts

import * as readline from 'readline';
import { RpcHandlers } from './rpc-handlers.js';

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class JsonRpcServer {
  private handlers: RpcHandlers;
  private rl: readline.Interface;

  constructor() {
    this.handlers = new RpcHandlers(this);

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    this.rl.on('line', (line) => this.handleLine(line));
    this.rl.on('close', () => {
      console.error('[Backend] stdin closed, exiting');
      process.exit(0);
    });

    console.error('[Backend] JSON-RPC server started');
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;

    try {
      const request: JsonRpcRequest = JSON.parse(line);
      await this.handleRequest(request);
    } catch (error) {
      console.error('[Backend] Parse error:', error);
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request;

    try {
      const result = await this.handlers.handle(method, params || {});

      if (id !== undefined) {
        this.sendResponse({ jsonrpc: '2.0', id, result });
      }
    } catch (error) {
      if (id !== undefined) {
        this.sendResponse({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
    }
  }

  sendResponse(response: JsonRpcResponse): void {
    console.log(JSON.stringify(response));
  }

  sendNotification(method: string, params: Record<string, unknown>): void {
    console.log(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }
}

// Start server
const server = new JsonRpcServer();

// Handle signals gracefully
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
