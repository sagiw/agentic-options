/**
 * Multi-agent swarm type definitions.
 * Defines the message protocol, agent roles, and state graph.
 */

import type { OptionsStrategy, OptionsOrder } from "./options.js";
import type { Portfolio, VaRResult } from "./portfolio.js";

/** Agent identifiers in the swarm */
export type AgentRole =
  | "orchestrator"    // The "Click" — lead coordinator
  | "browser"         // The "Eyes" — browser operator
  | "quant"           // The "Brain" — quantitative analyst
  | "risk"            // The "Shield" — risk sentinel
  | "human";          // Human-in-the-loop

/** Agent lifecycle states */
export type AgentStatus = "idle" | "thinking" | "acting" | "waiting" | "error";

/** Message passed between agents */
export interface AgentMessage {
  id: string;
  from: AgentRole;
  to: AgentRole;
  type: MessageType;
  payload: unknown;
  timestamp: Date;
  correlationId?: string; // links request/response pairs
}

export type MessageType =
  | "task_request"
  | "task_response"
  | "data_update"
  | "risk_alert"
  | "approval_request"
  | "approval_response"
  | "error"
  | "heartbeat";

/** Task delegated from orchestrator to a specialist agent */
export interface TaskRequest {
  taskId: string;
  action: TaskAction;
  params: Record<string, unknown>;
  priority: "low" | "medium" | "high" | "critical";
  deadline?: Date;
}

export type TaskAction =
  | "scrape_portfolio"
  | "scrape_bank_balance"
  | "fetch_option_chain"
  | "calculate_greeks"
  | "calculate_var"
  | "find_strategies"
  | "rank_strategies"
  | "validate_risk"
  | "place_order"
  | "request_human_approval";

/** Shared state visible to all agents (the "blackboard") */
export interface SwarmState {
  sessionId: string;
  portfolio: Portfolio | null;
  currentChains: Map<string, unknown>;
  suggestedStrategies: RankedStrategy[];
  pendingOrders: OptionsOrder[];
  riskAlerts: RiskAlert[];
  humanApprovalQueue: ApprovalRequest[];
  agentStatuses: Record<AgentRole, AgentStatus>;
  lastUpdated: Date;
}

/** Strategy with ranking score and explanation */
export interface RankedStrategy {
  strategy: OptionsStrategy;
  score: number; // 0–100 composite score
  factors: StrategyFactor[];
  riskAssessment: VaRResult;
  approved: boolean;
}

/** Individual factor contributing to strategy score */
export interface StrategyFactor {
  name: string;
  value: number;
  weight: number;
  contribution: number; // SHAP-like contribution
}

/** Risk alert from the Risk Sentinel */
export interface RiskAlert {
  id: string;
  severity: "info" | "warning" | "critical";
  message: string;
  metric: string;
  currentValue: number;
  threshold: number;
  timestamp: Date;
}

/** Human approval request (mandatory before execution) */
export interface ApprovalRequest {
  id: string;
  strategy: OptionsStrategy;
  explanation: ExplanationCard;
  riskAssessment: VaRResult;
  status: "pending" | "approved" | "rejected";
  requestedAt: Date;
  respondedAt?: Date;
}

/** XAI Explanation Card attached to every trade suggestion */
export interface ExplanationCard {
  summary: string;
  topFactors: StrategyFactor[];
  payoffDiagram: PayoffPoint[];
  ivAnalysis: string;
  riskWarnings: string[];
  confidence: number; // 0–1
}

/** Point on a payoff diagram */
export interface PayoffPoint {
  underlyingPrice: number;
  pnl: number;
  label?: string; // "breakeven", "max profit", etc.
}

/** Base interface all agents implement */
export interface Agent {
  role: AgentRole;
  status: AgentStatus;
  initialize(): Promise<void>;
  handleMessage(message: AgentMessage): Promise<AgentMessage | null>;
  shutdown(): Promise<void>;
}
