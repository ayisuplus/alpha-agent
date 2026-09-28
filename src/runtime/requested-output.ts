/**
 * What kind of output the user's objective asks for, read from its wording. A general task that ends with only a text
 * answer is checked against this: asking for a file, a source change or a web product and getting just an answer is
 * a failed run. The reading is clause by clause, so "直接回答，不需要生成文件" does not count as asking for a file.
 */
export interface RequestedOutput {
  deliverable: boolean;
  sourceChange: boolean;
  webProduct: boolean;
}

const PATTERNS: Record<keyof RequestedOutput, RegExp> = {
  deliverable: /(制作|生成|创建|输出|交付|导出|写一份|做一份).{0,30}(文件|文档|PDF|DOCX|XLSX|CSV|PPT|表格|报告|图片|视频|音频)/i,
  sourceChange: /(修复|修改|重构|实现|新增|编写|开发).{0,30}(代码|bug|项目|模块|功能|组件)/i,
  webProduct: /(创建|制作|开发|构建).{0,30}(网页|网站|web|页面|应用)/i,
};

const NEGATION = /(不需要|不需|无需|无须|不用|不必|不要|别|没必要|没有必要|no need|don't|do not|without)/i;

export function requestedOutput(objective: string): RequestedOutput {
  const clauses = objective.split(/[，。；;,.!?！？\n]/).filter(clause => !NEGATION.test(clause));
  const asks = (pattern: RegExp) => clauses.some(clause => pattern.test(clause));
  return { deliverable: asks(PATTERNS.deliverable), sourceChange: asks(PATTERNS.sourceChange), webProduct: asks(PATTERNS.webProduct) };
}
