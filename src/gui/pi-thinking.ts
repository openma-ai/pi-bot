const labels: Record<string, string> = {
    off: '关闭', minimal: '最低', low: '低', medium: '标准', high: '高', xhigh: '更高', max: '最高'
};

/** The runtime's SDK owns capabilities. Never infer them from a model name. */
export function piThinkingSelection(model: { reasoning?: boolean; thinkingLevels?: readonly string[] } | undefined, requested: string) {
    const known = Array.isArray(model?.thinkingLevels);
    const levels = [...new Set(known ? model!.thinkingLevels! : [])].filter(level => Object.hasOwn(labels, level));
    // Non-reasoning models have no adjustable effort; the explicit save uses off.
    const saveLevel = known && model?.reasoning === false ? 'off' : requested;
    const valid = known && levels.includes(saveLevel);
    const note = !known ? '当前运行环境尚未提供模型支持的思考档位，请更新运行环境后重新加载。'
        : model?.reasoning === false ? '此模型不支持调节思考强度，保存时使用关闭。'
        : !valid ? `当前选择「${labels[requested] ?? requested}」不受此模型支持，请明确选择一个可用档位。`
        : '';
    return { known, valid, saveLevel, value: valid ? saveLevel : '', note,
        items: levels.map(id => ({ id, name: labels[id] })) };
}
