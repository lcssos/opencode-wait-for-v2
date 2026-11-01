import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.ts"

/**
 * 把插件的 execute 抠出来直接测。
 * 真实链路是 ctx.tool.transform(editor => editor.add(tool))，这里只关心 execute 的行为。
 */
type Exec = (input: any, context: any) => Promise<{ content: string; metadata: any }>

let exec: Exec
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "wait-for-test-"))

  let captured: any
  const ctx = {
    tool: {
      transform: async (cb: (editor: any) => void) => {
        cb({ add: (tool: any) => (captured = tool) })
        return { dispose: async () => {} }
      },
    },
  }
  await plugin.setup(ctx as any)
  exec = captured.execute

  if (!exec) throw new Error("插件没有注册 wait_for 工具")
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const noSignal = { signal: new AbortController().signal, progress: async () => {} }

describe("wait_for", () => {
  test("注册了 wait_for 工具且带 codemode 选项", async () => {
    let captured: any
    await plugin.setup({
      tool: {
        transform: async (cb: (editor: any) => void) => {
          cb({ add: (t: any) => (captured = t) })
          return { dispose: async () => {} }
        },
      },
    } as any)
    expect(captured.name).toBe("wait_for")
    expect(captured.options).toEqual({ codemode: true })
    expect(captured.input.type).toBe("object")
  })

  test("文件已存在且匹配：立即返回", async () => {
    const p = join(dir, "ready.log")
    await writeFile(p, "step 1\nBUILD SUCCESS\n")

    const t0 = Date.now()
    const r = await exec({ path: p, pattern: "BUILD SUCCESS", timeout_ms: 5000 }, noSignal)
    const elapsed = Date.now() - t0

    expect(r.content).toContain("条件成立")
    expect(r.content).toContain("BUILD SUCCESS")
    expect(r.metadata.hit).toBe(true)
    // 必须远小于 timeout
    expect(elapsed).toBeLessThan(1000)
  })

  test("等待后写入：条件成立即返回，不等到 timeout", async () => {
    const p = join(dir, "later.log")
    await writeFile(p, "starting\n")

    setTimeout(() => {
      appendFile(p, "BUILD FAILURE\n").catch(() => {})
    }, 300)

    const t0 = Date.now()
    const r = await exec({ path: p, pattern: "BUILD (SUCCESS|FAILURE)", timeout_ms: 10000, poll_ms: 100 }, noSignal)
    const elapsed = Date.now() - t0

    expect(r.metadata.hit).toBe(true)
    expect(r.content).toContain("BUILD FAILURE")
    expect(elapsed).toBeLessThan(5000)
  })

  test("超时：返回 timed out 并附带日志尾部，而非抛错", async () => {
    const p = join(dir, "never.log")
    await writeFile(p, "starting\nstill going\n")

    const r = await exec({ path: p, pattern: "NEVER_APPEARS", timeout_ms: 800, poll_ms: 100 }, noSignal)

    expect(r.content).toContain("timed out")
    expect(r.content).toContain("日志未匹配")
    // 超时也必须带日志尾部，方便模型判断是慢还是卡死
    expect(r.content).toContain("still going")
    expect(r.metadata.hit).toBe(false)
    expect(r.metadata.reason).toBe("timeout")
  })

  test("文件不存在时超时：报告文件不存在", async () => {
    const p = join(dir, "missing.log")
    const r = await exec({ path: p, timeout_ms: 500, poll_ms: 100 }, noSignal)

    expect(r.content).toContain("文件还不存在")
    expect(r.metadata.hit).toBe(false)
  })

  test("pid 已退出：立即返回", async () => {
    // 用当前进程之外的必然已退出的 pid 不可靠，改为起一个短命进程
    const proc = Bun.spawn(["true"])
    const exitCode = await proc.exited
    const pid = proc.pid
    expect(exitCode).toBe(0)

    const t0 = Date.now()
    const r = await exec({ pid, timeout_ms: 3000 }, noSignal)
    expect(r.metadata.hit).toBe(true)
    expect(r.content).toContain("已退出")
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  test("pid 仍存活：超时且提示可能只是慢", async () => {
    const proc = Bun.spawn(["sleep", "10"])
    try {
      const r = await exec({ pid: proc.pid, timeout_ms: 600, poll_ms: 100 }, noSignal)
      expect(r.metadata.hit).toBe(false)
      expect(r.content).toContain("仍在运行")
      expect(r.content).toContain("可能只是慢")
    } finally {
      proc.kill()
    }
  })

  test("pid 活 + 日志匹配：两个条件都满足才返回", async () => {
    const p = join(dir, "both.log")
    const proc = Bun.spawn(["bash", "-c", `sleep 0.3; echo DONE > ${p}; sleep 10`])
    try {
      const t0 = Date.now()
      const r = await exec({ pid: proc.pid, path: p, pattern: "DONE", timeout_ms: 3000, poll_ms: 100 }, noSignal)
      // 日志已匹配，但进程还活着 → 不能返回，应超时
      expect(r.metadata.hit).toBe(false)
      expect(r.content).toContain("仍在运行")
      expect(Date.now() - t0).toBeGreaterThan(2000)
    } finally {
      proc.kill()
    }
  })

  test("must_be_new：历史匹配不算数", async () => {
    const p = join(dir, "stale.log")
    await writeFile(p, "BUILD SUCCESS\n")

    const r = await exec(
      { path: p, pattern: "BUILD SUCCESS", must_be_new: true, timeout_ms: 800, poll_ms: 100 },
      noSignal,
    )
    expect(r.metadata.hit).toBe(false)
    expect(r.content).toContain("尚未增长")
  })

  test("must_be_new：新增内容命中", async () => {
    const p = join(dir, "fresh.log")
    await writeFile(p, "BUILD SUCCESS (old)\n")

    setTimeout(() => {
      appendFile(p, "BUILD FAILURE (new)\n").catch(() => {})
    }, 250)

    const r = await exec(
      { path: p, pattern: "BUILD FAILURE", must_be_new: true, timeout_ms: 8000, poll_ms: 100 },
      noSignal,
    )
    expect(r.metadata.hit).toBe(true)
    expect(r.content).toContain("BUILD FAILURE (new)")
  })

  test("大文件只读尾部，命中很快", async () => {
    const p = join(dir, "big.log")
    const lines: string[] = []
    for (let i = 0; i < 50_000; i++) lines.push(`[INFO] line ${i} lorem ipsum dolor sit amet`)
    lines.push("BUILD SUCCESS")
    await writeFile(p, lines.join("\n"))

    const t0 = Date.now()
    const r = await exec({ path: p, pattern: "BUILD SUCCESS", timeout_ms: 5000, tail_lines: 5 }, noSignal)
    const elapsed = Date.now() - t0

    expect(r.metadata.hit).toBe(true)
    // 输出必须被 tail_lines 截断，不能把整个文件丢给模型
    expect(r.content.split("\n").length).toBeLessThan(15)
    expect(elapsed).toBeLessThan(500)
  })

  test("tail_lines 控制返回行数", async () => {
    const p = join(dir, "many.log")
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`)
    await writeFile(p, lines.join("\n"))

    const r = await exec({ path: p, timeout_ms: 2000, tail_lines: 10 }, noSignal)
    const body = r.content.split("--- 日志尾部 ---\n")[1] ?? ""
    expect(body.trim().split("\n").length).toBe(10)
  })

  test("参数校验：既无 path 也无 pid", async () => {
    await expect(exec({ timeout_ms: 100 }, noSignal)).rejects.toThrow(/至少需要 path 或 pid/)
  })

  test("参数校验：只有 pattern 没有 path", async () => {
    await expect(exec({ pattern: "x", timeout_ms: 100 }, noSignal)).rejects.toThrow(/pattern 需要配合 path/)
  })

  test("参数校验：非法正则", async () => {
    const p = join(dir, "x.log")
    await writeFile(p, "x")
    await expect(exec({ path: p, pattern: "([unclosed", timeout_ms: 100 }, noSignal)).rejects.toThrow(/不是合法正则/)
  })

  test("timeout_ms 上限被夹紧到 600s", async () => {
    const p = join(dir, "cap.log")
    await writeFile(p, "x")
    // 上限夹紧后仍然会等，所以用 abort 立刻退出，只验证不抛参数错误
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const ctx = { signal: controller.signal, progress: async () => {} }
    await expect(exec({ path: p, pattern: "nope", timeout_ms: 9_999_999 }, ctx)).rejects.toThrow(/中止/)
  })

  test("signal 中断：立刻停止等待", async () => {
    const p = join(dir, "abort.log")
    await writeFile(p, "x")
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)

    const t0 = Date.now()
    await expect(
      exec({ path: p, pattern: "nope", timeout_ms: 30000, poll_ms: 50 }, { signal: controller.signal, progress: async () => {} }),
    ).rejects.toThrow(/中止/)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  test("progress 上报不影响等待结果", async () => {
    const p = join(dir, "prog.log")
    await writeFile(p, "x")
    const notes: any[] = []
    const ctx = {
      signal: new AbortController().signal,
      progress: async (m: any) => {
        notes.push(m)
      },
    }
    const r = await exec({ path: p, pattern: "NEVER", timeout_ms: 1500, poll_ms: 100 }, ctx)
    expect(r.metadata.hit).toBe(false)
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0].status).toBe("waiting")
  })

  test("progress 抛错时等待照常完成", async () => {
    const p = join(dir, "prog-err.log")
    await writeFile(p, "done")
    const ctx = {
      signal: new AbortController().signal,
      progress: async () => {
        throw new Error("progress boom")
      },
    }
    const r = await exec({ path: p, pattern: "done", timeout_ms: 2000, poll_ms: 100 }, ctx)
    expect(r.metadata.hit).toBe(true)
  })
})
