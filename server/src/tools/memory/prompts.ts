// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆工具 Prompt
//
//   文件:       prompts.ts
//
//   日期:       2026年06月30日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

const BASE_MEMORY_RULES = [
  'GeoForge 记忆工具只用于长期、可复用、不可从当前仓库或运行事实源直接推导的信息。',
  'MEMORY.md 只是索引，不能保存正文；正文必须在独立 Markdown 文件中，并带 name、description、type frontmatter。',
  '记忆类型只允许 user、feedback、project、reference。',
  '不要保存代码结构、文件路径、Git 历史、当前临时任务、工具结果流水账，或任何可以通过读取仓库、运行记录、artifact、图层和配置重新得到的事实。',
  '记忆可能过期；涉及文件、函数、配置、图层、工具能力、数据产品时，必须先用当前事实源验证，再基于记忆给建议。',
].join('\n')

export const LIST_MEMORIES_PROMPT = [
  BASE_MEMORY_RULES,
  '',
  '用于查看可用记忆文件清单和摘要。只返回索引信息，不读取正文。',
  '当用户询问有哪些记忆、需要浏览记忆目录，或你需要先判断是否存在相关 topic file 时使用。',
].join('\n')

export const READ_MEMORY_PROMPT = [
  BASE_MEMORY_RULES,
  '',
  '用于读取单个长期记忆正文。',
  '只有当用户明确要求回忆、继续之前偏好、查看某条记忆，或 search_memory/list_memories 已指出需要读取该文件时使用。',
  '读取后仍要把记忆视作历史线索；若它提到当前文件、函数、配置、图层或工具能力，必须继续验证当前状态。',
].join('\n')

export const SEARCH_MEMORY_PROMPT = [
  BASE_MEMORY_RULES,
  '',
  '用于按用户问题检索相关长期记忆。',
  '当用户说“记得/之前/上次/回忆/按我的偏好/忘记什么”等，或当前任务明显可能受长期偏好、团队约定、外部引用影响时必须使用。',
  '搜索结果只说明哪些文件可能相关；需要正文事实时继续调用 read_memory。',
].join('\n')

export const WRITE_MEMORY_PROMPT = [
  BASE_MEMORY_RULES,
  '',
  '用于写入或更新长期记忆 topic file，并刷新同目录 MEMORY.md 索引。',
  '只有在用户明确要求“记住”，或本轮出现对未来有用且不可从仓库推导的稳定信息时使用。',
  'feedback 记忆应写清规则、原因和适用方式；project 记忆应把相对日期转换为绝对日期；reference 记忆只保存外部系统位置和用途。',
  '默认 user/个人沟通偏好写 private；团队级项目约束、测试政策、外部知识入口可写 team。敏感信息不得写入 team。',
].join('\n')

export const FORGET_MEMORY_PROMPT = [
  BASE_MEMORY_RULES,
  '',
  '用于删除长期记忆 topic file，并刷新同目录 MEMORY.md 索引。',
  '当用户要求忘记、删除、撤销某条记忆，或你确认某条记忆已经错误/过期且不应继续使用时调用。',
  '删除前应尽量基于 list_memories 或 search_memory 定位具体 relativePath，不能猜测路径。',
].join('\n')
