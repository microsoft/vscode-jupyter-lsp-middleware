const fd = require('fast-myers-diff')
const d = [...fd.diff('await test() # type: ignore\nprint("foo")\n', '\nawait test() # type: ignore\nprint("foo")\n')]
console.log(JSON.stringify(d))