/**
 * Cost estimate for a full simulation suite run, made BEFORE any paid run
 * (owner decision 2: $50/month hard cap). Prices are passed in (per million
 * tokens, USD) from the versioned pricing catalog; token figures should come
 * from a measured free/scripted run, not guesses.
 */
export interface ModelPrice {
  readonly model: string;
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

export interface SuiteShape {
  /** Scenario x language units that can run on the agent under test. */
  readonly units: number;
  readonly runsPerUnit: number;
  /** Average customer turns per run. */
  readonly customerTurns: number;
  /** Agent tokens per customer turn (all model calls of the turn). */
  readonly agentInputPerTurn: number;
  readonly agentOutputPerTurn: number;
  /** Simulated-customer tokens per turn (0 for the scripted customer). */
  readonly customerInputPerTurn: number;
  readonly customerOutputPerTurn: number;
  /** Judge tokens per run (0 while the judge is not used). */
  readonly judgeInputPerRun: number;
  readonly judgeOutputPerRun: number;
}

export interface CostEstimate {
  readonly runs: number;
  readonly agentUsd: number;
  readonly customerUsd: number;
  readonly judgeUsd: number;
  readonly totalUsd: number;
  /** Full suite runs that fit in the monthly cap. */
  readonly runsWithinCap: number;
}

const usd = (tokens: number, perMTok: number): number =>
  (tokens / 1_000_000) * perMTok;

export function estimateSuiteCost(
  shape: SuiteShape,
  prices: { agent: ModelPrice; customer: ModelPrice; judge: ModelPrice },
  monthlyCapUsd = 50,
): CostEstimate {
  const runs = shape.units * shape.runsPerUnit;
  const turns = runs * shape.customerTurns;
  const agentUsd =
    usd(turns * shape.agentInputPerTurn, prices.agent.inputPerMTok) +
    usd(turns * shape.agentOutputPerTurn, prices.agent.outputPerMTok);
  const customerUsd =
    usd(turns * shape.customerInputPerTurn, prices.customer.inputPerMTok) +
    usd(turns * shape.customerOutputPerTurn, prices.customer.outputPerMTok);
  const judgeUsd =
    usd(runs * shape.judgeInputPerRun, prices.judge.inputPerMTok) +
    usd(runs * shape.judgeOutputPerRun, prices.judge.outputPerMTok);
  const totalUsd = agentUsd + customerUsd + judgeUsd;
  return {
    runs,
    agentUsd,
    customerUsd,
    judgeUsd,
    totalUsd,
    runsWithinCap:
      totalUsd > 0
        ? Math.floor(monthlyCapUsd / totalUsd)
        : Number.POSITIVE_INFINITY,
  };
}
