import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { hash, insist, type Job, type JobInput, type Turn } from "../core/types.ts";

// JSON envelopes keep migrations small; indexed coordinates enforce critical uniqueness.
// Locations can load separate copies of this module, so the shared budget registry lives on globalThis.
const budgetRegistry = (globalThis as { __optchatBudgets?: { budgets: Map<string, Map<number, number>>; nextId: number } }).__optchatBudgets ??= { budgets: new Map(), nextId: 1 };
export class Store {
  readonly db: Database;
  private readonly owner = crypto.randomUUID();
  // Engines that share one database file add their runner budget here. The sum is the ceiling for
  // lease renewal, so a session moved to another Location cannot restart a job that exceeds the
  // concurrency of the whole database. Distinct in-memory stores stay independent.
  private readonly storeKey: string;
  private readonly budgetId = budgetRegistry.nextId++;
  private engineBudget = Number.MAX_SAFE_INTEGER;
  constructor(path = ":memory:") {
    this.storeKey = path === ":memory:" ? `memory:${this.owner}` : path;
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;");
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    insist(version <= 3, "SCHEMA_VERSION", "Database requires a newer OptChat version");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bucket,id));
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, session TEXT NOT NULL, generation INTEGER NOT NULL, seq INTEGER NOT NULL, eventKey TEXT NOT NULL, turnId TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(session,generation,seq), UNIQUE(session,generation,eventKey));
      CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, tree TEXT NOT NULL, start INTEGER NOT NULL, count INTEGER NOT NULL, value TEXT NOT NULL, UNIQUE(tree,start,count));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, input TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', fence INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE INDEX IF NOT EXISTS publications_visibility ON entities(bucket,json_extract(value,'$.scopeId'),json_extract(value,'$.sessionId'),json_extract(value,'$.generation'),json_extract(value,'$.publicationSeq')) WHERE bucket='publications';
      CREATE INDEX IF NOT EXISTS turns_active ON entities(json_extract(value,'$.sessionId'),json_extract(value,'$.generation')) WHERE bucket='turns' AND json_extract(value,'$.outcome') IS NULL;
      CREATE INDEX IF NOT EXISTS turns_completed_range ON entities(json_extract(value,'$.sessionId'),json_extract(value,'$.generation'),json_extract(value,'$.start') DESC,json_extract(value,'$.end') DESC) WHERE bucket='turns' AND json_extract(value,'$.outcome') IS NOT NULL AND json_extract(value,'$.end') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS staging_session ON entities(json_extract(value,'$.sessionId'),json_extract(value,'$.generation')) WHERE bucket='staging';
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS jobs_running_lease ON jobs(status,leaseUntil);
      CREATE INDEX IF NOT EXISTS jobs_evidence_coordinates ON jobs(status,json_extract(input,'$.type'),json_extract(input,'$.tree'),json_extract(input,'$.start'));
      CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS node_fts_insert AFTER INSERT ON nodes BEGIN
        INSERT INTO node_fts(id,text) VALUES(new.id,json_extract(new.value,'$.text'));
      END;
      CREATE TRIGGER IF NOT EXISTS node_fts_delete AFTER DELETE ON nodes BEGIN
        DELETE FROM node_fts WHERE id=old.id;
      END;
      INSERT INTO node_fts(id,text) SELECT id,json_extract(value,'$.text') FROM nodes WHERE id NOT IN (SELECT id FROM node_fts);
    `);
    this.transaction(() => {
      const columns = this.db.query("PRAGMA table_info(jobs)").all() as { name: string }[];
      if (!columns.some(column => column.name === "ownerPid")) this.db.exec("ALTER TABLE jobs ADD COLUMN ownerPid INTEGER");
      if (!columns.some(column => column.name === "ownerToken")) this.db.exec("ALTER TABLE jobs ADD COLUMN ownerToken TEXT");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS publication_candidates (turnKey TEXT PRIMARY KEY, tree TEXT NOT NULL, prepared INTEGER NOT NULL DEFAULT 0, queued INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS publication_dependencies (turnKey TEXT NOT NULL REFERENCES publication_candidates(turnKey) ON DELETE CASCADE, tree TEXT NOT NULL, start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(turnKey,start,count));
        CREATE INDEX IF NOT EXISTS publication_dependencies_coordinate ON publication_dependencies(tree,start,count);
        CREATE INDEX IF NOT EXISTS publication_candidates_state ON publication_candidates(prepared,queued);
        CREATE TRIGGER IF NOT EXISTS publication_candidate_insert AFTER INSERT ON entities WHEN new.bucket='turns' AND json_extract(new.value,'$.outcome') IS NOT NULL AND json_extract(new.value,'$.end') IS NOT NULL AND COALESCE(json_extract(new.value,'$.inherited'),0)=0 BEGIN
          INSERT OR IGNORE INTO publication_candidates(turnKey,tree) SELECT new.id,json_array('session',json_extract(new.value,'$.sessionId'),json_extract(new.value,'$.generation')) WHERE NOT EXISTS (SELECT 1 FROM entities WHERE bucket='publicationsByTurn' AND id=new.id);
        END;
        CREATE TRIGGER IF NOT EXISTS publication_candidate_update AFTER UPDATE ON entities WHEN new.bucket='turns' AND json_extract(new.value,'$.outcome') IS NOT NULL AND json_extract(new.value,'$.end') IS NOT NULL AND COALESCE(json_extract(new.value,'$.inherited'),0)=0 BEGIN
          INSERT OR IGNORE INTO publication_candidates(turnKey,tree) SELECT new.id,json_array('session',json_extract(new.value,'$.sessionId'),json_extract(new.value,'$.generation')) WHERE NOT EXISTS (SELECT 1 FROM entities WHERE bucket='publicationsByTurn' AND id=new.id);
        END;
        CREATE TRIGGER IF NOT EXISTS publication_candidate_turn_delete AFTER DELETE ON entities WHEN old.bucket='turns' BEGIN
          DELETE FROM publication_candidates WHERE turnKey=old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS publication_candidate_published AFTER INSERT ON entities WHEN new.bucket='publicationsByTurn' BEGIN
          DELETE FROM publication_candidates WHERE turnKey=new.id;
        END;
      `);
      if (version < 3) this.db.exec(`
        INSERT OR IGNORE INTO publication_candidates(turnKey,tree)
        SELECT t.id,json_array('session',json_extract(t.value,'$.sessionId'),json_extract(t.value,'$.generation')) FROM entities t
        JOIN entities s ON s.bucket='sessions' AND s.id=json_extract(t.value,'$.sessionId')
        WHERE t.bucket='turns' AND json_extract(t.value,'$.outcome') IS NOT NULL AND json_extract(t.value,'$.end') IS NOT NULL
          AND COALESCE(json_extract(t.value,'$.inherited'),0)=0 AND json_extract(s.value,'$.disabled') IS NULL
          AND COALESCE(json_extract(s.value,'$.broadcast'),1)!=0 AND json_extract(s.value,'$.generation')=json_extract(t.value,'$.generation')
          AND NOT EXISTS (SELECT 1 FROM entities p WHERE p.bucket='publicationsByTurn' AND p.id=t.id);
      `);
      this.db.exec("PRAGMA user_version=3");
    });
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  get<T>(bucket: string, id: string): T | undefined {
    const row = this.db.query("SELECT value FROM entities WHERE bucket=? AND id=?").get(bucket, id) as { value: string } | null;
    return row ? JSON.parse(row.value) : undefined;
  }
  set(bucket: string, id: string, value: unknown) {
    this.db.query("INSERT INTO entities VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET value=excluded.value").run(bucket, id, JSON.stringify(value));
  }
  remove(bucket: string, id: string) { this.db.query("DELETE FROM entities WHERE bucket=? AND id=?").run(bucket, id); }
  all<T>(bucket: string): T[] {
    return (this.db.query("SELECT value FROM entities WHERE bucket=? ORDER BY id").all(bucket) as { value: string }[]).map(r => JSON.parse(r.value));
  }
  hasActiveTurn(sessionId: string, generation: number): boolean {
    return !!this.db.query("SELECT 1 FROM entities WHERE bucket='turns' AND json_extract(value,'$.outcome') IS NULL AND json_extract(value,'$.sessionId')=? AND json_extract(value,'$.generation')=? LIMIT 1").get(sessionId, generation);
  }
  hasStagedRecords(sessionId: string, generation: number): boolean {
    return !!this.db.query("SELECT 1 FROM entities WHERE bucket='staging' AND json_extract(value,'$.sessionId')=? AND json_extract(value,'$.generation')=? LIMIT 1").get(sessionId, generation);
  }
  completedTurnForRange(sessionId: string, generation: number, start: number, end: number): Turn | undefined {
    // Terminal turns do not overlap. The nearest start can cover the range, or no turn can cover it.
    const row = this.db.query("SELECT value FROM entities WHERE bucket='turns' AND json_extract(value,'$.outcome') IS NOT NULL AND json_extract(value,'$.end') IS NOT NULL AND json_extract(value,'$.sessionId')=? AND json_extract(value,'$.generation')=? AND json_extract(value,'$.start')<=? ORDER BY json_extract(value,'$.start') DESC,json_extract(value,'$.end') DESC LIMIT 1").get(sessionId, generation, start) as { value: string } | null;
    const turn = row ? JSON.parse(row.value) as Turn : undefined;
    return turn && turn.end! >= end ? turn : undefined;
  }
  unpreparedPublicationKeys(): string[] {
    return (this.db.query("SELECT turnKey FROM publication_candidates WHERE prepared=0 ORDER BY turnKey").all() as { turnKey: string }[]).map(row => row.turnKey);
  }
  readyPublicationKeys(): string[] {
    return (this.db.query("SELECT c.turnKey FROM publication_candidates c WHERE c.prepared=1 AND c.queued=0 AND NOT EXISTS (SELECT 1 FROM publication_dependencies d WHERE d.turnKey=c.turnKey) ORDER BY c.turnKey").all() as { turnKey: string }[]).map(row => row.turnKey);
  }
  publicationDependents(tree: string, start: number, count: number): string[] {
    const rows = this.db.query("SELECT turnKey FROM publication_dependencies WHERE tree=? AND start=? AND count=? ORDER BY turnKey").all(tree, start, count) as { turnKey: string }[];
    this.db.query("DELETE FROM publication_dependencies WHERE tree=? AND start=? AND count=?").run(tree, start, count);
    return rows.map(row => row.turnKey);
  }
  enqueue(input: JobInput) {
    const value = JSON.stringify(input), id = hash(value);
    this.db.query("INSERT OR IGNORE INTO jobs(id,input) VALUES(?,?)").run(id, value);
    return id;
  }
  claim(now = Date.now(), leaseMs = 60000, maxRunning = Number.MAX_SAFE_INTEGER): Job | undefined {
    insist(Number.isSafeInteger(maxRunning) && maxRunning > 0, "CONFIG", "Job concurrency must be a positive integer");
    return this.transaction(() => {
      const owners = this.db.query("SELECT DISTINCT ownerPid FROM jobs WHERE status='running' AND ownerPid IS NOT NULL").all() as { ownerPid: number }[];
      for (const { ownerPid } of owners) {
        if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1) continue;
        try { process.kill(ownerPid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            this.db.query("UPDATE jobs SET status='pending',fence=fence+1,leaseUntil=0,ownerPid=NULL,ownerToken=NULL WHERE status='running' AND ownerPid=?").run(ownerPid);
          }
        }
      }
      const live = this.db.query("SELECT count(*) AS n FROM jobs WHERE status='running' AND leaseUntil>?").get(now) as { n: number };
      if (live.n >= maxRunning) return;
      const row = this.db.query("SELECT * FROM jobs WHERE rowid=(SELECT min(candidate) FROM (SELECT min(rowid) candidate FROM jobs WHERE status='pending' UNION ALL SELECT min(rowid) candidate FROM jobs WHERE status='running' AND leaseUntil<=?))").get(now) as (Omit<Job, "input"> & { input: string }) | null;
      if (!row) return;
      const fence = row.fence + 1;
      this.db.query("UPDATE jobs SET status='running', fence=?, leaseUntil=?, attempts=attempts+1,ownerPid=?,ownerToken=? WHERE id=?").run(fence, now + leaseMs, process.pid, this.owner, row.id);
      return { ...row, input: JSON.parse(row.input), fence, leaseUntil: now + leaseMs, attempts: row.attempts + 1, status: "running" };
    });
  }
  owns(job: Job) {
    const row = this.db.query("SELECT fence,status,leaseUntil FROM jobs WHERE id=?").get(job.id) as Pick<Job, "fence" | "status" | "leaseUntil"> | null;
    return row?.fence === job.fence && row.status === "running" && row.leaseUntil > Date.now();
  }
  // Declare how many jobs this engine may hold at once. Every engine on the same file contributes,
  // so the shared ceiling covers parallel Locations without persisting transient runtime state.
  contributeBudget(budget: number) {
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget === Number.MAX_SAFE_INTEGER) return;
    this.engineBudget = budget;
    let map = budgetRegistry.budgets.get(this.storeKey);
    if (!map) { map = new Map(); budgetRegistry.budgets.set(this.storeKey, map); }
    map.set(this.budgetId, budget);
  }
  concurrency(): number {
    // An engine without an explicit cap keeps the historical uncapped renewal behavior.
    if (this.engineBudget === Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
    const map = budgetRegistry.budgets.get(this.storeKey);
    if (!map || map.size === 0) return this.engineBudget;
    let total = 0;
    for (const value of map.values()) total = Math.min(Number.MAX_SAFE_INTEGER, total + value);
    return Math.max(1, total);
  }
  releaseBudget() { budgetRegistry.budgets.get(this.storeKey)?.delete(this.budgetId); }
  claimParentPeers(anchor: Job, limit: number, leaseMs: number, start: number, end: number): Job[] {
    return this.claimEvidencePeers(anchor, limit, leaseMs, start, end, "parent");
  }
  claimLeafPeers(anchor: Job, limit: number, leaseMs: number, start: number, end: number): Job[] {
    return this.claimEvidencePeers(anchor, limit, leaseMs, start, end, "leaf");
  }
  private claimEvidencePeers(anchor: Job, limit: number, leaseMs: number, start: number, end: number, type: "parent" | "leaf"): Job[] {
    if (anchor.input.type === "publication" || anchor.input.type !== type) return [];
    const tree = anchor.input.tree;
    return this.transaction(() => {
      const now = Date.now();
      if (!this.db.query("SELECT 1 FROM jobs WHERE id=? AND fence=? AND status='running' AND ownerToken=? AND leaseUntil>?").get(anchor.id, anchor.fence, this.owner, now)) return [];
      const rows = this.db.query("SELECT * FROM jobs WHERE status='pending' AND json_extract(input,'$.type')=? AND json_extract(input,'$.tree')=? AND json_extract(input,'$.start')>=? AND json_extract(input,'$.start')<? AND json_extract(input,'$.start')+COALESCE(json_extract(input,'$.count'),1)<=? ORDER BY json_extract(input,'$.start'),rowid LIMIT ?").all(type, tree, start, end, end, Math.max(0, Math.min(15, limit))) as (Omit<Job, "input"> & { input: string })[];
      return rows.map(row => {
        const fence = row.fence + 1;
        this.db.query("UPDATE jobs SET status='running',fence=?,leaseUntil=?,attempts=attempts+1,ownerPid=?,ownerToken=? WHERE id=?").run(fence, now + leaseMs, process.pid, this.owner, row.id);
        return { ...row, input: JSON.parse(row.input), fence, leaseUntil: now + leaseMs, attempts: row.attempts + 1, status: "running" as const };
      });
    });
  }
  renew(job: Job, leaseMs: number, now = Date.now()): boolean {
    return this.db.query("UPDATE jobs SET leaseUntil=? WHERE id=? AND fence=? AND status='running' AND leaseUntil>?").run(now + leaseMs, job.id, job.fence, now).changes === 1;
  }
  // Recover after suspension only if no other worker or retention change replaced this fence.
  recoverLease(job: Job, leaseMs: number, now = Date.now(), maxRunning = Number.MAX_SAFE_INTEGER): boolean {
    return this.db.query("UPDATE jobs SET leaseUntil=? WHERE id=? AND fence=? AND status='running' AND (SELECT count(*) FROM jobs WHERE status='running' AND leaseUntil>? AND id<>?)<?").run(now + leaseMs, job.id, job.fence, now, job.id, maxRunning).changes === 1;
  }
  release(job: Job) {
    return this.db.query("UPDATE jobs SET status='pending',fence=fence+1,leaseUntil=0,error=NULL WHERE id=? AND fence=? AND status='running'").run(job.id, job.fence).changes === 1;
  }
  fail(job: Job, error: unknown) {
    this.db.query("UPDATE jobs SET status='failed',error=? WHERE id=? AND fence=? AND status='running'").run(String(error), job.id, job.fence);
  }
  close() {
    this.db.query("UPDATE jobs SET status='pending',fence=fence+1,leaseUntil=0,ownerPid=NULL,ownerToken=NULL WHERE status='running' AND ownerToken=?").run(this.owner);
    this.db.close();
  }
}
