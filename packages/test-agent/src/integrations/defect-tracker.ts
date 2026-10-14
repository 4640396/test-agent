/**
 * DefectTracker 抽象接口（PRD 功能三：缺陷联动）。
 *
 * 将失败诊断的 real-bug 用例联动到外部缺陷跟踪系统（Jira 等）。
 * GUI 在诊断结果区为 category==='real-bug' 的用例显示『建单』按钮，
 * 点击后调用 createDefect() 把诊断字段组装成 DefectCreateInput 发送。
 *
 * [需人工复核-webhook闭环-二期] webhook 回写触发回归不在本期实现。
 */

/** 建单输入（从 FailedCaseRecord 组装）。 */
export interface DefectCreateInput {
  /** 用例名（作为缺陷标题）。 */
  title: string;
  /** 描述（错误信息 + 诊断证据 + 修复建议）。 */
  description: string;
  /** 诊断证据（代码位置 + 错误特征，可选）。 */
  evidence?: string;
  /** 修复建议（可选）。 */
  suggestion?: string;
  /** 用例名（冗余字段，便于后端记录来源）。 */
  caseName: string;
  /** 诊断分类（real-bug / test-defect / environment / flaky）。 */
  category: string;
  /** 截图路径列表（相对项目根，可选）。 */
  screenshots?: string[];
  /** 附件路径列表（绝对或相对路径，可选）。 */
  attachments?: string[];
}

/** 建单结果。 */
export interface DefectCreateResult {
  /** 是否成功。 */
  ok: boolean;
  /** 缺陷 ID（成功时由跟踪系统返回）。 */
  defectId?: string;
  /** 缺陷 URL（成功时由跟踪系统返回，GUI 展示为链接）。 */
  defectUrl?: string;
  /** 失败原因（ok=false 时填充）。 */
  error?: string;
}

/**
 * 缺陷跟踪器抽象接口。
 *
 * 实现方需保证：
 * - 凭据缺失或不可达时返回 { ok: false, error } 而非抛异常，不阻塞任务。
 * - HTTP 失败时返回 { ok: false, error } 而非抛异常。
 */
export interface DefectTracker {
  /** 创建缺陷工单。 */
  createDefect(input: DefectCreateInput): Promise<DefectCreateResult>;
  /** 健康检查（可选，返回是否可达）。 */
  ping?(): Promise<boolean>;
}
