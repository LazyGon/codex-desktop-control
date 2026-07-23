import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const AUTOMATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const AUTOMATION_KINDS = new Set(['cron', 'heartbeat']);
const AUTOMATION_STATUSES = new Set(['ACTIVE', 'PAUSED']);
const EXECUTION_ENVIRONMENTS = new Set(['local', 'worktree']);
const REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

const TOML_KEY_ORDER = [
  'version',
  'id',
  'kind',
  'name',
  'prompt',
  'status',
  'rrule',
  'target_thread_id',
  'execution_environment',
  'destination',
  'cwds',
  'model',
  'reasoning_effort',
  'local_environment_config_path',
  'notification_policy',
  'created_at',
  'updated_at',
];

function defaultCodexHome() {
  const configured = String(process.env.CODEX_HOME ?? '').trim();
  return configured || path.join(os.homedir(), '.codex');
}

function requiredString(value, field, maximum = 100_000) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value.length > maximum) throw new Error(`${field} is too long.`);
  return value;
}

function optionalString(value, field, maximum = 10_000) {
  if (value === undefined || value === null) return null;
  return requiredString(value, field, maximum);
}

function oneOf(value, allowed, field) {
  if (!allowed.has(value)) throw new Error(`${field} has an unsupported value.`);
  return value;
}

function validateId(value) {
  if (typeof value !== 'string' || !AUTOMATION_ID_PATTERN.test(value)) {
    throw new Error('Automation id must contain only letters, digits, underscores, or hyphens.');
  }
  return value;
}

function parseTomlValue(source, lineNumber) {
  const value = source.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`Unsupported TOML string on line ${lineNumber}.`);
    }
  }
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) throw new Error();
      return parsed;
    } catch {
      throw new Error(`Unsupported TOML array on line ${lineNumber}.`);
    }
  }
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Unsupported TOML value on line ${lineNumber}.`);
}

export function parseAutomationToml(source) {
  const result = {};
  const lines = String(source ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) throw new Error(`TOML tables are not supported on line ${index + 1}.`);
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) throw new Error(`Unsupported TOML syntax on line ${index + 1}.`);
    result[match[1]] = parseTomlValue(match[2], index + 1);
  }
  return result;
}

function tomlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return `[${value.map((entry) => JSON.stringify(entry)).join(', ')}]`;
  }
  throw new Error('Automation contains a value that cannot be serialized safely.');
}

export function serializeAutomationToml(automation) {
  const keys = [
    ...TOML_KEY_ORDER.filter((key) => automation[key] !== undefined && automation[key] !== null),
    ...Object.keys(automation)
      .filter((key) => !TOML_KEY_ORDER.includes(key) && automation[key] !== undefined && automation[key] !== null)
      .sort(),
  ];
  return `${keys.map((key) => `${key} = ${tomlValue(automation[key])}`).join('\n')}\n`;
}

function atomicWriteText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, text, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temporaryPath, filePath);
      return;
    } catch (error) {
      const retryable = ['EACCES', 'EBUSY', 'EPERM'].includes(error.code);
      if (!retryable || attempt >= 39) {
        try { fs.unlinkSync(temporaryPath); } catch {}
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function normalizedPathKey(value) {
  return path.resolve(String(value)).replaceAll('/', '\\').toLocaleLowerCase('en-US');
}

export class AutomationStore {
  constructor({
    codexHome = defaultCodexHome(),
    now = () => Date.now(),
    idFactory = () => `automation-${randomUUID()}`,
  } = {}) {
    this.codexHome = path.resolve(codexHome);
    this.automationsRoot = path.join(this.codexHome, 'automations');
    this.globalStatePath = path.join(this.codexHome, '.codex-global-state.json');
    this.now = now;
    this.idFactory = idFactory;
  }

  execute(argumentsValue, { threadId = null } = {}) {
    const args = argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
      ? argumentsValue
      : {};
    const mode = requiredString(args.mode, 'mode', 32);
    if (mode === 'suggested_create' || mode === 'suggested_update') {
      throw new Error(`${mode} requires confirmation in Codex Desktop and is not applied through Discord.`);
    }
    if (mode === 'view') return { automation: this.#view(validateId(args.id)) };
    if (mode === 'delete') return this.#delete(validateId(args.id));
    if (mode === 'create') return { automation: this.#create(args, threadId) };
    if (mode === 'update') return { automation: this.#update(args, threadId) };
    throw new Error(`Unsupported automation mode: ${mode}.`);
  }

  listProjects() {
    const projects = this.#globalState()['local-projects'] ?? {};
    return Object.entries(projects)
      .filter(([, project]) => Array.isArray(project?.rootPaths) && project.rootPaths.length > 0)
      .map(([projectId, project]) => ({
        projectId,
        hostId: 'local',
        name: typeof project.name === 'string' && project.name.trim() ? project.name : projectId,
        rootPaths: project.rootPaths.map((rootPath) => requiredString(rootPath, 'project root path', 10_000)),
      }));
  }

  project(projectId) {
    const id = requiredString(projectId, 'projectId', 500);
    const project = this.listProjects().find((candidate) => candidate.projectId === id);
    if (!project) throw new Error(`Codex Desktop local project not found: ${id}.`);
    return project;
  }

  #automationPath(id) {
    const safeId = validateId(id);
    return path.join(this.automationsRoot, safeId, 'automation.toml');
  }

  #read(id) {
    const filePath = this.#automationPath(id);
    let source;
    try {
      source = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Automation not found: ${id}.`);
      throw error;
    }
    const automation = parseAutomationToml(source);
    if (automation.id !== id) throw new Error(`Automation file id does not match its directory: ${id}.`);
    return automation;
  }

  #view(id) {
    return this.#toToolShape(this.#read(id));
  }

  #create(args, threadId) {
    let id;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      id = validateId(this.idFactory());
      if (!fs.existsSync(this.#automationPath(id))) break;
      id = null;
    }
    if (!id) throw new Error('Could not allocate a unique automation id.');
    const timestamp = this.now();
    const automation = this.#fromToolShape(args, {
      id,
      threadId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const filePath = this.#automationPath(id);
    fs.mkdirSync(this.automationsRoot, { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: false });
    try {
      atomicWriteText(filePath, serializeAutomationToml(automation));
    } catch (error) {
      try { fs.rmdirSync(path.dirname(filePath)); } catch {}
      throw error;
    }
    return this.#toToolShape(automation);
  }

  #update(args, threadId) {
    const id = validateId(args.id);
    const existing = this.#read(id);
    const automation = this.#fromToolShape(args, {
      id,
      threadId,
      createdAt: existing.created_at,
      updatedAt: this.now(),
    });
    atomicWriteText(this.#automationPath(id), serializeAutomationToml(automation));
    return this.#toToolShape(automation);
  }

  #delete(id) {
    const filePath = this.#automationPath(id);
    if (!fs.existsSync(filePath)) throw new Error(`Automation not found: ${id}.`);
    fs.unlinkSync(filePath);
    const directory = path.dirname(filePath);
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    return { deleted: true, id };
  }

  #fromToolShape(args, { id, threadId, createdAt, updatedAt }) {
    const kind = oneOf(args.kind, AUTOMATION_KINDS, 'kind');
    const status = oneOf(args.status, AUTOMATION_STATUSES, 'status');
    const automation = {
      version: 1,
      id,
      kind,
      name: requiredString(args.name, 'name', 500),
      prompt: requiredString(args.prompt, 'prompt'),
      status,
      rrule: requiredString(args.rrule, 'rrule', 4_000),
    };

    if (kind === 'heartbeat') {
      if (args.destination !== undefined) oneOf(args.destination, new Set(['local', 'thread']), 'destination');
      const targetThreadId = optionalString(args.targetThreadId, 'targetThreadId', 200)
        ?? optionalString(threadId, 'threadId', 200);
      if (!targetThreadId) throw new Error('Heartbeat automation requires a target thread id.');
      automation.target_thread_id = targetThreadId;
    } else {
      automation.execution_environment = oneOf(
        args.executionEnvironment,
        EXECUTION_ENVIRONMENTS,
        'executionEnvironment',
      );
      const destination = args.destination ?? automation.execution_environment;
      automation.destination = oneOf(destination, new Set(['local', 'worktree']), 'destination');
      automation.cwds = this.#projectPaths(args.projectId);
      automation.model = requiredString(args.model, 'model', 500);
      automation.reasoning_effort = oneOf(args.reasoningEffort, REASONING_EFFORTS, 'reasoningEffort');
      const environmentConfig = optionalString(
        args.localEnvironmentConfigPath,
        'localEnvironmentConfigPath',
        10_000,
      );
      if (environmentConfig) automation.local_environment_config_path = environmentConfig;
    }

    if (args.notificationPolicy !== undefined && args.notificationPolicy !== null) {
      if (args.notificationPolicy !== 'failed_runs_only') {
        throw new Error('notificationPolicy has an unsupported value.');
      }
      automation.notification_policy = args.notificationPolicy;
    }
    automation.created_at = Number.isSafeInteger(createdAt) ? createdAt : updatedAt;
    automation.updated_at = updatedAt;
    return automation;
  }

  #toToolShape(automation) {
    const kind = oneOf(automation.kind, AUTOMATION_KINDS, 'kind');
    const result = {
      id: validateId(automation.id),
      kind,
      name: requiredString(automation.name, 'name', 500),
      prompt: requiredString(automation.prompt, 'prompt'),
      rrule: requiredString(automation.rrule, 'rrule', 4_000),
      status: oneOf(automation.status, AUTOMATION_STATUSES, 'status'),
      notificationPolicy: automation.notification_policy ?? null,
      createdAt: automation.created_at ?? null,
      updatedAt: automation.updated_at ?? null,
    };
    if (kind === 'heartbeat') {
      result.destination = 'thread';
      result.targetThreadId = optionalString(automation.target_thread_id, 'target_thread_id', 200);
    } else {
      result.executionEnvironment = oneOf(
        automation.execution_environment,
        EXECUTION_ENVIRONMENTS,
        'execution_environment',
      );
      result.destination = automation.destination ?? result.executionEnvironment;
      result.projectId = this.#projectIdForPaths(automation.cwds ?? []);
      result.model = requiredString(automation.model, 'model', 500);
      result.reasoningEffort = oneOf(
        automation.reasoning_effort,
        REASONING_EFFORTS,
        'reasoning_effort',
      );
      result.localEnvironmentConfigPath = automation.local_environment_config_path ?? null;
    }
    return result;
  }

  #globalState() {
    try {
      return JSON.parse(fs.readFileSync(this.globalStatePath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error(`Could not read Codex Desktop project state: ${error.message}`);
    }
  }

  #projectPaths(projectId) {
    if (projectId === null) return [];
    const id = requiredString(projectId, 'projectId', 500);
    const project = this.#globalState()['local-projects']?.[id];
    if (!project || !Array.isArray(project.rootPaths) || project.rootPaths.length === 0) {
      throw new Error(`Codex Desktop local project not found: ${id}.`);
    }
    return project.rootPaths.map((rootPath) => requiredString(rootPath, 'project root path', 10_000));
  }

  #projectIdForPaths(cwds) {
    if (!Array.isArray(cwds) || cwds.length === 0) return null;
    const expected = cwds.map(normalizedPathKey).sort();
    const projects = this.#globalState()['local-projects'] ?? {};
    for (const [id, project] of Object.entries(projects)) {
      if (!Array.isArray(project?.rootPaths)) continue;
      const candidate = project.rootPaths.map(normalizedPathKey).sort();
      if (candidate.length === expected.length && candidate.every((value, index) => value === expected[index])) {
        return id;
      }
    }
    return null;
  }
}
