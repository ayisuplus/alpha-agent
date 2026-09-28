/**
 * What the objective itself forbids in words — "不要使用“最”“第一”这类绝对化用语" — enforced at acceptance by the
 * runtime instead of trusting the model's self-report. This is the difference between "the model said it complied"
 * and "the delivered answer provably complies": a task whose stated prohibitions are violated must never reach
 * "已验收".
 *
 * Terms are only read from prohibition clauses with quoted words or explicit enumerations, so an objective that
 * merely discusses a word ("不需要生成文件") creates no prohibition. The scan surface is the task's full text
 * answer, exactly what the person reads in the thread and what independent checks grade.
 */

/** Clause-level trigger: an instruction not to use/appear/include something. */
const PROHIBITION =
  /(不要使用|不要用|不要出现|不要包含|不要带|禁止使用|禁止出现|禁止包含|禁止|不得使用|不得出现|不得包含|避免使用|避免出现|避免|别用|别写|不能使用|不能出现|严禁使用|严禁|忌用|不应使用|不应出现)/;

/** Paired quotes so adjacent spans (“最”“第一”) each contribute a term instead of one span across them. */
const QUOTED = /(?:“([^”]{1,24})”|"([^"]{1,24})"|'([^']{1,24})'|‘([^’]{1,24})’|「([^」]{1,24})」)/g;

/** Trailing category words that name the class instead of a term: "色情、暴力内容" is about 色情 and 暴力. */
const CATEGORY_SUFFIX = /(?:这类|之类的|等等|等|词语|用语|表述|说法|字眼|表达|内容|词|字)$/;

/**
 * The prohibited terms the objective states, in first-seen order and without duplicates. A prohibition clause
 * contributes its quoted words; without quotes it only contributes an explicit enumeration of two or more short
 * terms, because "不要使用绝对化用语" names a category, not a term to match.
 */
export function statedProhibitions(objective: string): string[] {
  const terms = new Set<string>();
  for (const clause of objective.split(/[，。；;,.!?！？\n]/)) {
    if (!PROHIBITION.test(clause)) continue;
    const quoted = [...clause.matchAll(QUOTED)].map(match => match.slice(1).find(part => part !== undefined)!.trim()).filter(Boolean);
    if (quoted.length) {
      for (const term of quoted) terms.add(term);
      continue;
    }
    const tail = clause.slice(clause.search(PROHIBITION)).replace(PROHIBITION, "");
    const parts = tail
      .split(/[、／/和与及]/)
      .map(part => part.replace(CATEGORY_SUFFIX, "").replace(/^[的了]|["“”'‘’「」]/g, "").trim())
      .filter(part => part.length > 0 && part.length <= 12);
    if (parts.length >= 2) for (const part of parts) terms.add(part);
  }
  return [...terms];
}

/** Which of the stated terms appear in the text, in the order the objective stated them. */
export function prohibitionViolations(text: string, terms: readonly string[]): string[] {
  return terms.filter(term => text.includes(term));
}
