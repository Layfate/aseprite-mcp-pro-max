/** An error whose message is safe and useful to show to the model/user. */
export class McpToolError extends Error {
    code;
    hint;
    constructor(code, message, hint) {
        super(message);
        this.code = code;
        this.hint = hint;
        this.name = "McpToolError";
    }
}
//# sourceMappingURL=errors.js.map