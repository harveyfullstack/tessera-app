export type ShardQueryOutcome<Row> =
  | { kind: "rows"; rows: readonly Row[] }
  | { kind: "timeout" }
  | { kind: "blank" };

export interface QueryShard<Row> {
  id: string;
  query(statement: string): Promise<ShardQueryOutcome<Row>>;
}

export interface ShardQueryRoute<Row> {
  preferred: QueryShard<Row>;
  replicas: readonly QueryShard<Row>[];
}

export type RoutedShardQueryOutcome<Row> = ShardQueryOutcome<Row> & { shardId: string };

/** Routes reads to the designated shard; replica selection is a later delivery concern. */
export class ShardQueryRouter<Row> {
  async query(statement: string, route: ShardQueryRoute<Row>): Promise<RoutedShardQueryOutcome<Row>> {
    const outcome = await route.preferred.query(statement);

    return { ...outcome, shardId: route.preferred.id };
  }
}
