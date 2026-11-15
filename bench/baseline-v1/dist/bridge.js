import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { McpToolError } from "./errors.js";
/** Where the bridge advertises its port/token for the Aseprite extension. */
export const BRIDGE_INFO_PATH = path.join(homedir(), ".aseprite-mcp", "bridge.json");
/**
 * Live editor bridge. The MCP server listens on 127.0.0.1; the Aseprite
 * extension reads ~/.aseprite-mcp/bridge.json and connects with the token.
 * Requests use the same command format as batch mode, executed by the same
 * Lua core inside the running editor (wrapped in undoable transactions).
 */
export class LiveBridge {
    preferredPort;
    log;
    wss;
    socket;
    pending = new Map();
    hello;
    error;
    token = randomBytes(16).toString("hex");
    port;
    constructor(preferredPort, log = () => undefined) {
        this.preferredPort = preferredPort;
        this.log = log;
    }
    start() {
        return new Promise((resolve) => {
            const wss = new WebSocketServer({ host: "127.0.0.1", port: this.preferredPort });
            wss.on("listening", () => {
                this.wss = wss;
                const addr = wss.address();
                this.port = typeof addr === "object" && addr ? addr.port : this.preferredPort;
                try {
                    mkdirSync(path.dirname(BRIDGE_INFO_PATH), { recursive: true });
                    writeFileSync(BRIDGE_INFO_PATH, JSON.stringify({ port: this.port, token: this.token, pid: process.pid }), { mode: 0o600 });
                }
                catch (e) {
                    this.error = `could not write ${BRIDGE_INFO_PATH}: ${e.message}`;
                }
                resolve();
            });
            wss.on("error", (err) => {
                this.error = err.code === "EADDRINUSE" ? `port ${this.preferredPort} is in use (another MCP server instance owns the live bridge)` : err.message;
                this.log(`live bridge disabled: ${this.error}`);
                resolve();
            });
            wss.on("connection", (ws, req) => {
                const url = new URL(req.url ?? "/", "http://127.0.0.1");
                if (url.searchParams.get("token") !== this.token) {
                    ws.close(4001, "bad token");
                    return;
                }
                this.socket?.close(4000, "replaced by a newer connection");
                this.socket = ws;
                this.hello = undefined;
                ws.on("message", (raw) => this.onMessage(ws, raw.toString()));
                ws.on("close", () => {
                    if (this.socket === ws) {
                        this.socket = undefined;
                        this.failAll(new McpToolError("ASEPRITE_FAILED", "the Aseprite editor disconnected"));
                    }
                });
            });
        });
    }
    onMessage(ws, text) {
        let msg;
        try {
            msg = JSON.parse(text);
        }
        catch {
            return;
        }
        if (msg.type === "hello") {
            this.hello = { aseprite: msg.aseprite, extension: msg.extension };
            return;
        }
        if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
            return;
        }
        if (!msg.id)
            return;
        const p = this.pending.get(msg.id);
        if (!p)
            return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        const env = msg.envelope;
        if (env?.ok)
            p.resolve(env.data);
        else
            p.reject(new McpToolError("SCRIPT_ERROR", env?.error ?? "unknown error from the editor"));
    }
    failAll(err) {
        for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
            this.pending.delete(id);
        }
    }
    get connected() {
        return !!this.socket && this.socket.readyState === this.socket.OPEN;
    }
    status() {
        return {
            listening: !!this.wss,
            port: this.port,
            connected: this.connected,
            aseprite: this.hello?.aseprite,
            extension: this.hello?.extension,
            error: this.error,
        };
    }
    request(req, timeoutMs = 60_000) {
        if (!this.connected || !this.socket) {
            throw new McpToolError("ASEPRITE_FAILED", "the live Aseprite editor is not connected", this.wss
                ? "Install the bridge extension (aseprite_live action=install_extension), restart Aseprite, and keep it open."
                : `The live bridge is not listening: ${this.error ?? "disabled"}.`);
        }
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new McpToolError("TIMEOUT", `the editor did not answer within ${timeoutMs} ms`));
            }, timeoutMs);
            this.pending.set(id, { resolve: resolve, reject, timer });
            this.socket.send(JSON.stringify({ id, req }));
        });
    }
    async stop() {
        this.failAll(new McpToolError("ASEPRITE_FAILED", "server shutting down"));
        this.socket?.close();
        await new Promise((r) => (this.wss ? this.wss.close(() => r()) : r()));
        if (this.wss)
            rmSync(BRIDGE_INFO_PATH, { force: true });
    }
}
//# sourceMappingURL=bridge.js.map