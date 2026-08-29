import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("published tui entrypoint keeps its runtime imports in dependencies", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const runtimeImports = ["@opentui/solid", "solid-js"]

  for (const dependency of runtimeImports) {
    expect(packageJson.dependencies?.[dependency]).toBeString()
    expect(packageJson.devDependencies?.[dependency]).toBeUndefined()
  }
})

// The shipped bundle must resolve with nothing beside it. It was once built with
// `--external effect --external zod`, which made it import both as bare
// specifiers; a checkout without a node_modules then failed to load the plugin
// silently, with nothing in the OpenCode log, and a fix that had been "shipped"
// for days had never run. Node builtins are the only imports a plugin file can
// safely assume its host can resolve.
test("the shipped bundle imports nothing it cannot resolve on its own", () => {
  const bundle = readFileSync("dist/server.js", "utf8")
  const specifiers = new Set(
    [...bundle.matchAll(/\bfrom\s*"([^"]+)"/g)].map((match) => match[1]!).filter((spec) => !spec.startsWith(".")),
  )

  const nodeBuiltins = new Set(["crypto", "fs/promises", "os", "path", "fs", "util", "url", "events", "stream"])
  const unresolvable = [...specifiers].filter((spec) => !nodeBuiltins.has(spec) && !spec.startsWith("node:"))

  expect(unresolvable).toEqual([])
})
