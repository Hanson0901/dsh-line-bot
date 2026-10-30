// 把工具定義補成宿主要求的形狀（output schema + render），並把參數映射轉成 JSON Schema。
// 做法與 dsh-tieba-dive 的 lib/toolkit.mjs 相同：宿主有 dsh-tools 就用它的 defineTool，
// 沒有就自己補；這樣外掛不必把 dsh-tools 宣告成依賴。
let base = (spec) => spec
let usingHost = false

try {
  const mod = await import('dsh-tools')
  if (typeof mod.defineTool === 'function') {
    base = mod.defineTool
    usingHost = true
  }
} catch {
  /* 宿主沒給，用本地兜底 */
}

export const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

export function toJsonSchema(params) {
  if (!params) return { type: 'object', properties: {}, required: [] }
  if (params.type === 'object') return params
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(params)) {
    if (!value || typeof value !== 'object') continue
    const { required: isRequired, ...schema } = value
    properties[key] = schema
    if (isRequired === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export function defineTool(spec) {
  if (usingHost) return base({ output: textOutput, ...spec })
  return base({ output: textOutput, ...spec, parameters: toJsonSchema(spec.parameters) })
}
