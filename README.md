# BS Image Differ

## What
Compares any two game versions and extracts newly added images.

## Run
1. `npm install`
2. `node .\app.mjs "C:\path\to\old\brightershores\version\assetBundle3" "C:\path\to\new\brightershores\version\assetBundle3"`

## WASM
Precompiled WebAssembly files are included for convenience.  
If you prefer to rebuild them yourself (requires Emscripten), run:  
`emcc "bs-unpacker/libs/bcdec/bcdec.c" -o "bs-unpacker/wasm/bcdec.js" -s EXPORTED_FUNCTIONS="['_bcdec_bc1','_bcdec_bc3','_bcdec_bc4','_bcdec_bc5','_bcdec_r8','_malloc','_free']" -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap']" -s WASM=1 -s MODULARIZE=1 -s ENVIRONMENT=node -s EXPORT_ES6=1 -s ALLOW_MEMORY_GROWTH`
