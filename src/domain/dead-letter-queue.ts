export interface DeadLetterEntry {
  accountId: string;
  briefId: string;
  dispatchJobId: string;
  endpointUrl: string;
  movedAt: Date;
}

export interface MoveToDeadLetterInput {
  accountId: string;
  briefId: string;
  dispatchJobId: string;
  endpointUrl: string;
}

export interface DeadLetterQueue {
  move(input: MoveToDeadLetterInput): Promise<DeadLetterEntry>;
  listByBrief(briefId: string): Promise<DeadLetterEntry[]>;
}
