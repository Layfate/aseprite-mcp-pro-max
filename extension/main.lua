-- Aseprite MCP Pro Max — live editor bridge extension (unofficial).
--
-- Reads ~/.aseprite-mcp/bridge.json (written by the MCP server), connects to
-- ws://127.0.0.1:<port> with the shared token and executes requests with the
-- same Lua core used in batch mode. Every edit runs inside app.transaction,
-- so it shows up as a single undoable step in the editor.

local EXT_VERSION = "1.0.0"
local core
local ws
local connected = false
local currentKey
local timer
local lastError

local function stateDir()
  local home = os.getenv("USERPROFILE") or os.getenv("HOME") or "."
  return app.fs.joinPath(home, ".aseprite-mcp")
end

local function infoPath()
  return app.fs.joinPath(stateDir(), "bridge.json")
end

-- Small rolling diagnostic log: ~/.aseprite-mcp/extension.log
local function log(msg)
  pcall(function()
    local f = io.open(app.fs.joinPath(stateDir(), "extension.log"), "a")
    if f then
      f:write(os.date("%Y-%m-%d %H:%M:%S "), msg, "\n")
      f:close()
    end
  end)
end

local lastReadNote
local function readInfo()
  local f, openErr = io.open(infoPath(), "rb")
  local note
  if not f then
    note = "cannot open " .. infoPath() .. ": " .. tostring(openErr)
  else
    local s = f:read("a")
    f:close()
    local ok, info = pcall(json.decode, s)
    -- Aseprite's json.decode returns a userdata JSON object, not a plain table.
    if ok and info ~= nil and info.port and info.token then
      return { port = math.tointeger(tonumber(info.port)), token = tostring(info.token) }
    end
    note = "invalid bridge.json (" .. tostring(info) .. "): " .. tostring(s):sub(1, 80)
  end
  if note ~= lastReadNote then log(note); lastReadNote = note end
  return nil
end

local function send(t)
  if ws and connected then ws:sendText(json.encode(t)) end
end

local function onMessage(mt, data)
  if mt == WebSocketMessageType.OPEN then
    log("connected")
    connected = true
    lastError = nil
    send({ type = "hello", aseprite = tostring(app.version), extension = EXT_VERSION })
  elseif mt == WebSocketMessageType.CLOSE then
    if connected then log("disconnected") end
    connected = false
  elseif mt == WebSocketMessageType.ERROR then
    connected = false
    lastError = tostring(data)
    log("error: " .. lastError)
  elseif mt == WebSocketMessageType.TEXT then
    local ok, msg = pcall(json.decode, data)
    if not ok or msg == nil or not msg.id or msg.req == nil then return end
    local envelope = core.handle(msg.req, { live = true })
    local encOk, encoded = pcall(json.encode, { id = msg.id, envelope = envelope })
    if not encOk then
      encoded = json.encode({ id = msg.id, envelope = { ok = false, error = "failed to encode response: " .. tostring(encoded) } })
    end
    ws:sendText(encoded)
  end
end

local function connect(info)
  if ws then pcall(function() ws:close() end) end
  connected = false
  currentKey = tostring(info.port) .. ":" .. info.token
  log("connecting to port " .. tostring(info.port))
  ws = WebSocket {
    url = string.format("ws://127.0.0.1:%d/?token=%s", info.port, info.token),
    onreceive = onMessage,
    deliverFragments = false,
    minreconnectwait = 2,
    maxreconnectwait = 10,
  }
  ws:connect()
end

local lastTickNote
local function tick()
  if connected then return end
  local ok, err = pcall(function()
    local info = readInfo()
    local note = info and ("server on port " .. tostring(info.port)) or "no bridge.json"
    if note ~= lastTickNote then log(note); lastTickNote = note end
    if info and (tostring(info.port) .. ":" .. info.token) ~= currentKey then connect(info) end
  end)
  if not ok then log("tick failed: " .. tostring(err)) end
end

function init(plugin)
  -- Batch processes (aseprite -b, used by the MCP server itself) load
  -- extensions too; only the interactive editor may connect.
  if not app.isUIAvailable then return end
  log("init (Aseprite " .. tostring(app.version) .. ", extension " .. EXT_VERSION .. ")")
  local ok, err = pcall(function() core = dofile(app.fs.joinPath(plugin.path, "core.lua")) end)
  if not ok then
    log("failed to load core.lua: " .. tostring(err))
    return
  end
  pcall(function()
    plugin:newCommand {
      id = "AsepriteMcpBridgeStatus",
      title = "MCP Bridge Status",
      group = "file_scripts",
      onclick = function()
        local info = readInfo()
        app.alert {
          title = "Aseprite MCP Pro Max",
          text = {
            "Extension " .. EXT_VERSION .. " (core " .. tostring(core.version) .. ")",
            connected and "Connected to the MCP server." or "Not connected.",
            info and ("Server port: " .. tostring(info.port)) or "No MCP server found (~/.aseprite-mcp/bridge.json missing).",
            lastError and ("Last error: " .. lastError) or "",
          },
        }
      end,
    }
  end)
  timer = Timer { interval = 3.0, ontick = tick }
  timer:start()
  tick()
end

function exit(plugin)
  if timer then timer:stop() end
  if ws then pcall(function() ws:close() end) end
end
