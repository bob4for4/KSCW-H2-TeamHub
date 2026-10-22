// Syntax check for the hub's scripts without Node: osascript -l JavaScript tests/check_syntax.js
// (macOS JavaScriptCore). Prints "ok" per file, or the error and line.
ObjC.import("Foundation");
function run() {
  const dir = $.NSString.alloc.initWithUTF8String($.NSFileManager.defaultManager.currentDirectoryPath.js).js;
  return ["app.js", "config.js"].map((f) => {
    const t = $.NSString.stringWithContentsOfFileEncodingError(dir + "/" + f, $.NSUTF8StringEncoding, null).js;
    try { new Function(t); return f + ": ok"; } catch (e) { return f + ": " + e.message + " (line " + e.line + ")"; }
  }).join("\n");
}
