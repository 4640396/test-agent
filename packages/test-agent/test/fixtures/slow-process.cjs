const { spawn } = require('node:child_process')
const fs = require('node:fs')

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
// 同步写入 fd 1（stdout），确保数据在进程被 taskkill 之前已进入管道
fs.writeSync(1, `CHILD_PID=${child.pid}\n`)
setInterval(() => {}, 1000)
