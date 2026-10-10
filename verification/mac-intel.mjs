// 对下载的安装镜像做独立空数据目录验收，不检出或发布业务源码。
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import assert from 'node:assert/strict'

const output = resolve('verification-output')
await mkdir(output, { recursive: true })
assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'x64')
const report = { version: '0.1.7-rc.2.20261010.3', platform: process.platform, arch: process.arch,
  source: 'downloaded-dmg', pages: [], ready: false, notarized: false }
const child = spawn(process.env.VERIFY_EXECUTABLE, ['--remote-debugging-port=0'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NODE_OPTIONS: '', DSH_TELEMETRY_DISABLED: '1',
    LAVEDA_DESKTOP_DATA_DIR: join(process.env.RUNNER_TEMP, 'laveda-dmg-empty-profile') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let messages = '', socket, serial = 0, phase = '启动'
child.stdout.on('data', data => { messages += data })
child.stderr.on('data', data => { messages += data })
const cdp = (method, params = {}) => new Promise((done, fail) => {
  const id = ++serial
  const handler = event => {
    const item = JSON.parse(event.data)
    if (item.id !== id) return
    clearTimeout(timer); socket.removeEventListener('message', handler)
    if (item.error) fail(new Error('界面调试命令失败'))
    else done(item.result)
  }
  const timer = setTimeout(() => { socket.removeEventListener('message', handler); fail(new Error('界面响应超时')) }, 15000)
  socket.addEventListener('message', handler)
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const value = await cdp('Runtime.evaluate', { expression, returnByValue: true })
  if (value.exceptionDetails) throw new Error('界面脚本未能执行')
  return value.result.value
}
const connect = async target => {
  socket?.close(); socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
}
const waitUntil = async (check, message, timeout = 120000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    assert.equal(child.exitCode, null, '应用提前退出')
    const value = await check()
    if (value) return value
    await pause(500)
  }
  throw new Error(message)
}
const settled = async name => {
  let stable = 0, last
  await waitUntil(async () => {
    last = await evaluate(`(() => {
      const main=document.querySelector('main');
      const text=main?.innerText ?? '';
      const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};
      const busy=[...document.querySelectorAll('main .ant-spin-spinning,main [aria-busy="true"],main .ant-skeleton-active')].filter(visible).length;
      return {length:text.length,busy,loading:/加载业务数据|正在加载/.test(text),error:/服务暂不可用|TOULIU_CONNECTION_UNAVAILABLE/.test(text),connected:document.body.innerText.includes('API 已连接')};
    })()`)
    const ok = last.length > 20 && last.connected && !last.loading && !last.busy && !last.error
    stable = ok ? stable + 1 : 0
    return stable >= 8
  }, name + '未能结束加载')
  report.pages.push({ name, settled: true, ...last })
}
const screenshot = async name => {
  const picture = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(output, name), Buffer.from(picture.data, 'base64'))
}

try {
  const port = await waitUntil(() => messages.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1], '调试窗口未就绪')
  const targets = async () => fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
  phase = '登录'
  const welcome = await waitUntil(async () => (await targets()).find(t => t.type === 'page' && t.url.includes('/welcome.html')), '登录窗口未出现')
  await connect(welcome)
  await waitUntil(() => evaluate('!!document.querySelector("#login-username:not(:disabled)")'), '登录框未就绪')
  await evaluate(`(() => {
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    for(const [id,value] of [['login-username','admin'],['login-password','admin123']]) {
      const element=document.getElementById(id);set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));
    } return true;
  })()`)
  await pause(500)
  assert.equal(await evaluate(`(() => {const b=document.querySelector('button[form="laveda-login-form"]');if(!b||b.disabled)return false;b.click();return true})()`), true, '登录按钮不可用')
  const app = await waitUntil(async () => (await targets()).find(t => t.type === 'page' && t.url.startsWith('dsh-app://app/')), '登录后工作台未出现')
  await connect(app)
  phase = '总览工作台'
  await settled(phase)
  await screenshot('workbench-settled.png')
  for (const [name, file] of [['投前定轮','planning-settled.png'], ['数据与商品','data-settled.png']]) {
    phase = name
    const clicked = await evaluate(`(() => {const b=[...document.querySelectorAll('nav button')].find(e=>e.innerText.trim()===${JSON.stringify(name)});if(!b)return false;b.click();return true})()`)
    assert.equal(clicked, true, '导航按钮不可用')
    await pause(1000)
    await settled(name)
    await screenshot(file)
  }
  report.ready = true
} catch (error) {
  report.failure = { phase, reason: error.message }
  process.exitCode = 1
} finally {
  report.verifiedAt = new Date().toISOString()
  await writeFile(join(output, 'verification-result.json'), JSON.stringify(report, null, 2))
  socket?.close()
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await once(child, 'exit'); clearTimeout(timer)
  }
  console.log(JSON.stringify(report))
}
