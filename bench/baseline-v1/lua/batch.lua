-- Batch-mode entry point. Usage:
--   aseprite -b --script-param request=<req.json> --script-param response=<res.json> --script batch.lua
local here = debug.getinfo(1, "S").source:sub(2):match("^(.*)[/\\]") or "."
local core = dofile(here .. "/core.lua")

local function readFile(p)
  local f = assert(io.open(p, "rb"))
  local s = f:read("a")
  f:close()
  return s
end

local envelope
local ok, err = pcall(function()
  local req = json.decode(readFile(app.params.request))
  envelope = core.handle(req, { live = false })
end)
if not ok then envelope = { ok = false, error = "invalid request: " .. tostring(err) } end

local encOk, encoded = pcall(json.encode, envelope)
if not encOk then encoded = json.encode({ ok = false, error = "failed to encode response: " .. tostring(encoded) }) end
local f = assert(io.open(app.params.response, "wb"))
f:write(encoded)
f:close()
