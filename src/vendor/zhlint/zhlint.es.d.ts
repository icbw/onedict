/** zhlint 0.8.2 vendored ESM 构建的最小类型声明（仅声明本项目消费面：
 *  run(str, { hyperParse: [] }) 的纯文本排版检查；完整类型见上游 lib/*.d.ts）。 */

export interface ZhlintValidation {
  /** 规则名（如 punctuation-full-width / content-space-mixed-width） */
  name: string;
  /** 中文消息（上游自带，直接展示） */
  message: string;
  index: number;
  length: number;
  target: string;
}

export interface ZhlintResult {
  origin: string;
  result: string;
  validations: ZhlintValidation[];
}

export interface ZhlintOptions {
  logger?: Console;
  /** 预处理器（markdown / hexo / ignore 注释）；传空数组 = 纯文本检查 */
  hyperParse?: Array<string | ((status: unknown) => unknown)>;
  /** 规则选项；preset: "default" 启用默认规则集（不传 = 规则全关） */
  rules?: { preset?: string } & Record<string, unknown>;
  ignoredCases?: unknown[];
}

export declare const run: (str: string, options?: ZhlintOptions) => ZhlintResult;
