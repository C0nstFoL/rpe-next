import { agentSchema, agentText } from '../core/agent-commands.mjs';
import { agentScriptChanges } from '../core/agent-script.mjs';
import { runAgentChartScript } from '../platform/agent-script.mjs';

export function registerAgentScriptingTools(commands, editor, { check, prepareChart, script = runAgentChartScript }) {
  commands.register({ name: 'agent_tools', description: '发现所有编辑器、谱面、音频、素材、文件及模组命令。按 query 搜索用途或命令名，或用 names 精确选择；返回的命令会在下一次模型请求提供完整参数定义。空查询返回分类。不要猜参数，也不要把未显示的命令视为不存在。', access: 'read', parameters: agentSchema({ query: agentText, names: { type: 'array', items: agentText, maxItems: 30 }, limit: { type: 'integer', minimum: 1, maximum: 30 } }), prepare: args => ({ apply: () => {
    const entries = [...commands.entries.values()];
    if (!args.query && !args.names?.length) return { categories: [...new Set(entries.map(entry => entry.name.split('_')[0]))], total: entries.length, hint: '按用途、中文关键词或命令名搜索；names 可精确选择。' };
    const query = (args.query ?? '').toLowerCase();
    const selected = entries.filter(entry => args.names?.includes(entry.name) || query && (entry.name + ' ' + entry.description).toLowerCase().includes(query));
    return { total: selected.length, commands: selected.slice(0, args.limit ?? 20).map(entry => ({ name: entry.name, description: entry.description, access: entry.access, owner: entry.owner })) };
  } }) });
  commands.register({ name: 'chart_script', description: '在独立 Worker 中执行 JavaScript，直接读写完整谱面副本，支持任意算法、循环、筛选、音符/事件/判定线/噪域/模组数据操作。chart 是可变副本，input 为自定义数据。api.createNote(type,beat,positionX,endBeat=beat+1)，仅Hold(type=2)使用endBeat，其余首尾相同；api.createEvent(start,end,startBeat,endBeat)；api.createLine(name?)；api.createNoiseArea(startBeat,endBeat)；api.createNoiseEvent(start,end,startBeat,endBeat,anchor?)。这些构造器的拍参数用十进制数；直接写time字段用api.fromNumber(number)生成拍数组。另有api.beatValue(array)、parseBeat(text)、easing(progress,id)、clone(value)、report(value)。默认采用修改后的chart，可return {chart,result}返回另一谱面和简短统计。没有DOM、联网、凭据或本机文件访问；宿主验证后一次提交，可撤销。整线删除/重排及大量删除按危险操作审批；dryRun只预览计划。', access: 'edit', parameters: agentSchema({ revision: agentText, source: { type: 'string', maxLength: 200000 }, input: {}, label: agentText, dryRun: { type: 'boolean' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 30000 } }, ['revision', 'source']), prepare: async (args, { signal }) => {
    const before = check(args), result = await script(args.source, before, args.input, signal, { timeout: args.timeoutMs ?? 10000 });
    const changes = agentScriptChanges(before, result.chart, result.origins);
    const plan = prepareChart(args, before, result.chart, args.label ?? '执行谱面脚本', { changes, result: result.result }, changes.dangerous);
    plan.details = { ...plan.details, source: args.source, input: args.input };
    if (args.dryRun) return { ...plan, access: 'read', apply: () => ({ dryRun: true, ...changes, result: result.result }) };
    return plan;
  } });
}
