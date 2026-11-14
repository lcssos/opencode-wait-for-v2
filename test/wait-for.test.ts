import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.ts"

/**
 * Extract the plugin's execute function and test it directly.
 * The real path is ctx.tool.transform(editor => editor.add(tool)); this only exercises execute.
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

  if (!exec) throw new Error("plugin did not register the wait_for tool")
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const noSignal = { signal: new AbortController().signal, progress: async () => {} }

describe("wait_for", () => {
  test("registers wait_for with the codemode option", async () => {
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

  test("existing matching file: returns immediately", async () => {
    const p = join(dir, "ready.log")
    await writeFile(p, "step 1\nBUILD SUCCESS\n")

    const t0 = Date.now()
    const r = await exec({ path: p, pattern: "BUILD SUCCESS", timeout_ms: 5000 }, noSignal)
    const elapsed = Date.now() - t0

    expect(r.content).toContain("condition met")
    expect(r.content).toContain("BUILD SUCCESS")
    expect(r.metadata.hit).toBe(true)
    // Must be far below the timeout
    expect(elapsed).toBeLessThan(1000)
  })

  test("content written later: returns on match, not at timeout", async () => {
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

  test("timeout: returns timed out with the log tail instead of throwing", async () => {
    const p = join(dir, "never.log")
    await writeFile(p, "starting\nstill going\n")

    const r = await exec({ path: p, pattern: "NEVER_APPEARS", timeout_ms: 800, poll_ms: 100 }, noSignal)

    expect(r.content).toContain("timed out")
    expect(r.content).toContain("log did not match")
    // A timeout must include the log tail so the model can tell slow from stuck
    expect(r.content).toContain("still going")
    expect(r.metadata.hit).toBe(false)
    expect(r.metadata.reason).toBe("timeout")
  })

  test("missing file timeout: reports that the file does not exist", async () => {
    const p = join(dir, "missing.log")
    const r = await exec({ path: p, timeout_ms: 500, poll_ms: 100 }, noSignal)

    expect(r.content).toContain("file does not exist yet")
    expect(r.metadata.hit).toBe(false)
  })

  test("pid already exited: returns immediately", async () => {
    // A PID outside this process is not guaranteed to be gone; spawn a short-lived process instead
    const proc = Bun.spawn(["true"])
    const exitCode = await proc.exited
    const pid = proc.pid
    expect(exitCode).toBe(0)

    const t0 = Date.now()
    const r = await exec({ pid, timeout_ms: 3000 }, noSignal)
    expect(r.metadata.hit).toBe(true)
    expect(r.content).toContain("exited")
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  test("pid still alive: times out and suggests it may simply be slow", async () => {
    const proc = Bun.spawn(["sleep", "10"])
    try {
      const r = await exec({ pid: proc.pid, timeout_ms: 600, poll_ms: 100 }, noSignal)
      expect(r.metadata.hit).toBe(false)
      expect(r.content).toContain("still running")
      expect(r.content).toContain("may simply be slow")
    } finally {
      proc.kill()
    }
  })

  test("pid alive + log match: requires both conditions", async () => {
    const p = join(dir, "both.log")
    const proc = Bun.spawn(["bash", "-c", `sleep 0.3; echo DONE > ${p}; sleep 10`])
    try {
      const t0 = Date.now()
      const r = await exec({ pid: proc.pid, path: p, pattern: "DONE", timeout_ms: 3000, poll_ms: 100 }, noSignal)
      // The log matched but the process is still alive -> must not return; expect a timeout
      expect(r.metadata.hit).toBe(false)
      expect(r.content).toContain("still running")
      expect(Date.now() - t0).toBeGreaterThan(2000)
    } finally {
      proc.kill()
    }
  })

  test("must_be_new: stale matches do not count", async () => {
    const p = join(dir, "stale.log")
    await writeFile(p, "BUILD SUCCESS\n")

    const r = await exec(
      { path: p, pattern: "BUILD SUCCESS", must_be_new: true, timeout_ms: 800, poll_ms: 100 },
      noSignal,
    )
    expect(r.metadata.hit).toBe(false)
    expect(r.content).toContain("has not grown")
  })

  test("must_be_new: matches new content", async () => {
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

  test("large file: reads only the tail and matches quickly", async () => {
    const p = join(dir, "big.log")
    const lines: string[] = []
    for (let i = 0; i < 50_000; i++) lines.push(`[INFO] line ${i} lorem ipsum dolor sit amet`)
    lines.push("BUILD SUCCESS")
    await writeFile(p, lines.join("\n"))

    const t0 = Date.now()
    const r = await exec({ path: p, pattern: "BUILD SUCCESS", timeout_ms: 5000, tail_lines: 5 }, noSignal)
    const elapsed = Date.now() - t0

    expect(r.metadata.hit).toBe(true)
    // Output must be truncated by tail_lines; never send the whole file to the model
    expect(r.content.split("\n").length).toBeLessThan(15)
    expect(elapsed).toBeLessThan(500)
  })

  test("tail_lines controls the returned line count", async () => {
    const p = join(dir, "many.log")
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`)
    await writeFile(p, lines.join("\n"))

    const r = await exec({ path: p, timeout_ms: 2000, tail_lines: 10 }, noSignal)
    const body = r.content.split("--- log tail ---\n")[1] ?? ""
    expect(body.trim().split("\n").length).toBe(10)
  })

  test("validation: neither path nor pid", async () => {
    await expect(exec({ timeout_ms: 100 }, noSignal)).rejects.toThrow(/requires at least one of path or pid/)
  })

  test("validation: pattern without path", async () => {
    await expect(exec({ pattern: "x", timeout_ms: 100 }, noSignal)).rejects.toThrow(/pattern requires path/)
  })

  test("validation: invalid regular expression", async () => {
    const p = join(dir, "x.log")
    await writeFile(p, "x")
    await expect(exec({ path: p, pattern: "([unclosed", timeout_ms: 100 }, noSignal)).rejects.toThrow(/not a valid regular expression/)
  })

  test("timeout_ms is capped at 600s", async () => {
    const p = join(dir, "cap.log")
    await writeFile(p, "x")
    // The cap still waits, so abort immediately; this only checks that no parameter error is thrown
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const ctx = { signal: controller.signal, progress: async () => {} }
    await expect(exec({ path: p, pattern: "nope", timeout_ms: 9_999_999 }, ctx)).rejects.toThrow(/aborted/)
  })

  test("signal abort: stops the wait immediately", async () => {
    const p = join(dir, "abort.log")
    await writeFile(p, "x")
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)

    const t0 = Date.now()
    await expect(
      exec({ path: p, pattern: "nope", timeout_ms: 30000, poll_ms: 50 }, { signal: controller.signal, progress: async () => {} }),
    ).rejects.toThrow(/aborted/)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  test("progress reporting does not affect the wait result", async () => {
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

  test("wait completes even when progress throws", async () => {
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
