/**
 * The "Click" — Lead Orchestrator Agent
 *
 * Manages the entire trading workflow:
 *   1. Receives user intent (e.g., "find best options play on AAPL")
 *   2. Delegates sub-tasks to specialist agents
 *   3. Collects results and presents ranked strategies
 *   4. Manages human-in-the-loop approval flow
 *   5. Routes approved orders to the brokerage
 *
 * Uses a state-machine pattern for workflow management.
 */

import EventEmitter from "eventemitter3";
import { agentLogger } from "../utils/logger.js";
import { generateId } from "../utils/validation.js";
import type {
  Agent,
  AgentMessage,
  AgentRole,
  AgentStatus,
  SwarmState,
  TaskRequest,
  TaskAction,
  ApprovalRequest,
  RankedStrategy,
} from "../types/agents.js";

const log = agentLogger("orchestrator");

/** Workflow phases */
type WorkflowPhase =
  | "idle"
  | "gathering_data"      // browser + market data
  | "analyzing"           // quant calculations
  | "risk_checking"       // risk sentinel validation
  | "presenting"          // showing results to user
  | "awaiting_approval"   // human-in-the-loop
  | "executing"           // order submission
  | "complete"
  | "error";

export class Orchestrator extends EventEmitter implements Agent {
  readonly role: AgentRole = "orchestrator";
  status: AgentStatus = "idle";

  private phase: WorkflowPhase = "idle";
  private state: SwarmState;
  private agents: Map<AgentRole, Agent> = new Map();

  constructor() {
    super();
    this.state = this.createInitialState();
  }

  /** Register specialist agents in the swarm */
  registerAgent(agent: Agent): void {
    this.agents.set(agent.role, agent);
    log.info(`Registered agent: ${agent.role}`);
  }

  async initialize(): Promise<void> {
    log.info("Initializing orchestrator...");
    this.status = "idle";
    this.phase = "idle";

    // Initialize all registered agents
    for (const [role, agent] of this.agents) {
      try {
        await agent.initialize();
        this.state.agentStatuses[role] = "idle";
        log.info(`Agent ${role} initialized`);
      } catch (err) {
        log.error(`Failed to initialize agent ${role}`, { error: err });
        this.state.agentStatuses[role] = "error";
      }
    }
  }

  /**
   * Main entry point: start an analysis workflow.
   *
   * @param symbol - The underlying ticker to analyze
   * @param userIntent - Natural language description of what the user wants
   */
  async startWorkflow(symbol: string, userIntent: string): Promise<RankedStrategy[]> {
    log.info(`Starting workflow for ${symbol}: "${userIntent}"`);
    this.phase = "gathering_data";
    this.status = "thinking";

    try {
      // ── Phase 1: Gather Data ──────────────────────────────
      log.info("Phase 1: Gathering portfolio and market data...");
      const portfolioTask = this.delegateTask("browser", "scrape_portfolio", {});
      const chainTask = this.delegateTask("quant", "fetch_option_chain", { symbol });
      await Promise.all([portfolioTask, chainTask]);

      // ── Phase 2: Quantitative Analysis ────────────────────
      this.phase = "analyzing";
      log.info("Phase 2: Running quantitative analysis...");
      const analysisResult = await this.delegateTask("quant", "find_strategies", {
        symbol,
        intent: userIntent,
      });

      // ── Phase 3: Risk Validation ──────────────────────────
      this.phase = "risk_checking";
      log.info("Phase 3: Validating risk limits...");
      const validatedStrategies = await this.delegateTask("risk", "validate_risk", {
        strategies: this.state.suggestedStrategies,
      });

      // ── Phase 4: Present to User ──────────────────────────
      this.phase = "presenting";
      log.info(`Phase 4: Presenting ${this.state.suggestedStrategies.length} strategies`);
      this.emit("strategies_ready", this.state.suggestedStrategies);

      return this.state.suggestedStrategies;
    } catch (err) {
      this.phase = "error";
      this.status = "error";
      log.error("Workflow failed", { error: err });
      throw err;
    }
  }

  /**
   * Human-in-the-loop approval.
   * Called when the user approves a strategy for execution.
   */
  async approveStrategy(strategyIndex: number): Promise<void> {
    const strategy = this.state.suggestedStrategies[strategyIndex];
    if (!strategy) {
      throw new Error(`Invalid strategy index: ${strategyIndex}`);
    }

    this.phase = "awaiting_approval";
    log.info(`Strategy approved: ${strategy.strategy.name}`);

    strategy.approved = true;

    // Create approval record
    const approval: ApprovalRequest = {
      id: generateId(),
      strategy: strategy.strategy,
      explanation: {
        summary: `Executing ${strategy.strategy.name}`,
        topFactors: strategy.factors,
        payoffDiagram: [],
        ivAnalysis: "",
        riskWarnings: [],
        confidence: strategy.score / 100,
      },
      riskAssessment: strategy.riskAssessment,
      status: "approved",
      requestedAt: new Date(),
      respondedAt: new Date(),
    };

    this.state.humanApprovalQueue.push(approval);

    // ── Phase 5: Execute ──────────────────────────────────
    this.phase = "executing";
    log.info("Phase 5: Executing approved strategy...");
    await this.delegateTask("browser", "place_order", {
      strategy: strategy.strategy,
    });

    this.phase = "complete";
    this.status = "idle";
    log.info("Workflow complete");
  }

  /** Handle incoming messages from other agents */
  async handleMessage(message: AgentMessage): Promise<AgentMessage | null> {
    log.debug(`Received message from ${message.from}: ${message.type}`);

    switch (message.type) {
      case "data_update":
        this.handleDataUpdate(message);
        return null;

      case "risk_alert":
        this.handleRiskAlert(message);
        return null;

      case "task_response":
        // Task completed by sub-agent
        return null;

      case "error":
        log.error(`Error from ${message.from}`, { payload: message.payload });
        return null;

      default:
        log.warn(`Unhandled message type: ${message.type}`);
        return null;
    }
  }

  async shutdown(): Promise<void> {
    log.info("Shutting down orchestrator...");
    for (const [, agent] of this.agents) {
      await agent.shutdown();
    }
    this.status = "idle";
    this.phase = "idle";
  }

  /** Get current workflow state (for XAI dashboard) */
  getState(): Readonly<SwarmState> {
    return { ...this.state, lastUpdated: new Date() };
  }

  // ─── Private Methods ────────────────────────────────────────

  private async delegateTask(
    to: AgentRole,
    action: TaskAction,
    params: Record<string, unknown>
  ): Promise<AgentMessage | null> {
    const agent = this.agents.get(to);
    if (!agent) {
      log.warn(`No agent registered for role: ${to}`);
      return null;
    }

    const message: AgentMessage = {
      id: generateId(),
      from: "orchestrator",
      to,
      type: "task_request",
      payload: {
        taskId: generateId(),
        action,
        params,
        priority: "high",
      } satisfies TaskRequest,
      timestamp: new Date(),
    };

    this.state.agentStatuses[to] = "acting";
    const response = await agent.handleMessage(message);
    this.state.agentStatuses[to] = "idle";

    return response;
  }

  private handleDataUpdate(message: AgentMessage): void {
    // Update shared state with new data from agents
    const payload = message.payload as Record<string, unknown>;
    if (payload.portfolio) {
      this.state.portfolio = payload.portfolio as SwarmState["portfolio"];
    }
    this.state.lastUpdated = new Date();
  }

  private handleRiskAlert(message: AgentMessage): void {
    const alert = message.payload as SwarmState["riskAlerts"][0];
    this.state.riskAlerts.push(alert);
    log.warn(`Risk alert: ${alert.message}`, { severity: alert.severity });
    this.emit("risk_alert", alert);
  }

  private createInitialState(): SwarmState {
    return {
      sessionId: generateId(),
      portfolio: null,
      currentChains: new Map(),
      suggestedStrategies: [],
      pendingOrders: [],
      riskAlerts: [],
      humanApprovalQueue: [],
      agentStatuses: {
        orchestrator: "idle",
        browser: "idle",
        quant: "idle",
        risk: "idle",
        human: "idle",
      },
      lastUpdated: new Date(),
    };
  }
}
