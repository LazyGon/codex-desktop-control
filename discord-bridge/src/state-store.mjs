import path from 'node:path';
import {
  atomicWriteJson,
  deepClone,
  projectIdFromKey,
  readJsonIfPresent,
} from './util.mjs';

function initialState(guildId) {
  return {
    schemaVersion: 6,
    guildId,
    infrastructure: {
      controlCategoryId: null,
      controlChannelId: null,
      alertsChannelId: null,
      completionsChannelId: null,
      transferCategoryId: null,
      transferTextChannelId: null,
      archiveCategoryIds: [],
    },
    projectCategories: {},
    bindings: {},
    subagentThreads: {},
    clientToolRequests: {},
    lastReadyAt: null,
  };
}

export class StateStore {
  constructor(dataDir, guildId) {
    this.filePath = path.join(dataDir, 'state.json');
    const persisted = readJsonIfPresent(this.filePath);
    this.value = persisted?.guildId === guildId ? persisted : initialState(guildId);
    if (this.value.schemaVersion === 1) {
      this.value.infrastructure.controlCategoryId ??= this.value.infrastructure.categoryId ?? null;
      delete this.value.infrastructure.categoryId;
      this.value.schemaVersion = 2;
    }
    if (this.value.schemaVersion === 2) {
      for (const [projectKey, project] of Object.entries(this.value.projectCategories ?? {})) {
        project.projectId ??= projectIdFromKey(projectKey);
      }
      for (const binding of Object.values(this.value.bindings ?? {})) {
        binding.turnMessages ??= {};
        if (binding.lastCompletedTurnId && binding.lastCompletionMessageId) {
          binding.turnMessages[binding.lastCompletedTurnId] ??= {};
          binding.turnMessages[binding.lastCompletedTurnId].finalMessageIds ??= [binding.lastCompletionMessageId];
          binding.turnMessages[binding.lastCompletedTurnId].status ??= 'completed';
        }
      }
      this.value.schemaVersion = 3;
    }
    if (this.value.schemaVersion === 3) {
      for (const binding of Object.values(this.value.bindings ?? {})) {
        for (const record of Object.values(binding.turnMessages ?? {})) {
          record.cardMessageId ??= record.liveMessageId ?? record.finalMessageIds?.[0] ?? null;
        }
      }
      this.value.schemaVersion = 4;
    }
    if (this.value.schemaVersion === 4) {
      this.value.clientToolRequests ??= {};
      this.value.schemaVersion = 5;
    }
    if (this.value.schemaVersion === 5) {
      this.value.subagentThreads ??= {};
      this.value.schemaVersion = 6;
    }
    if (this.value.schemaVersion !== 6) this.value = initialState(guildId);
    delete this.value.bindings?.undefined;
    delete this.value.subagentThreads?.undefined;
    for (const binding of Object.values(this.value.bindings ?? {})) {
      binding.snapshotInitialized ??= true;
      binding.turnMessages ??= {};
      binding.controlPanelMessageId ??= null;
      binding.lastPanelCompletionTurnId ??= null;
      binding.completionReportsEnabled ??= true;
    }
    this.value.infrastructure.archiveCategoryIds ??= [];
    this.value.infrastructure.controlPanelMessageId ??= null;
    this.value.infrastructure.transferCategoryId ??= null;
    this.value.infrastructure.transferTextChannelId ??= null;
    this.value.projectCategories ??= {};
    this.value.subagentThreads ??= {};
    for (const subagent of Object.values(this.value.subagentThreads)) {
      subagent.turnMessages ??= {};
      subagent.discordArchived ??= false;
    }
    this.value.clientToolRequests ??= {};
    delete this.value.autoCatchupProjects;
    this.#write();
  }

  snapshot() {
    return deepClone(this.value);
  }

  update(mutator) {
    mutator(this.value);
    this.#write();
    return this.snapshot();
  }

  binding(threadId) {
    if (this.value.bindings[threadId]) {
      return { ...deepClone(this.value.bindings[threadId]), threadId };
    }
    if (this.value.subagentThreads[threadId]) {
      return { ...deepClone(this.value.subagentThreads[threadId]), threadId, isSubagent: true };
    }
    return null;
  }

  bindingByChannel(channelId) {
    const entry = Object.entries(this.value.bindings).find(([, binding]) => binding.channelId === channelId);
    return entry ? { threadId: entry[0], ...deepClone(entry[1]) } : null;
  }

  bindings() {
    return Object.entries(this.value.bindings).map(([threadId, binding]) => ({ threadId, ...deepClone(binding) }));
  }

  subagentThread(threadId) {
    const value = this.value.subagentThreads[threadId];
    return value ? { ...deepClone(value), threadId, isSubagent: true } : null;
  }

  subagentThreadByDiscordId(discordThreadId) {
    const entry = Object.entries(this.value.subagentThreads)
      .find(([, value]) => value.channelId === discordThreadId);
    return entry ? { threadId: entry[0], ...deepClone(entry[1]), isSubagent: true } : null;
  }

  subagentThreads() {
    return Object.entries(this.value.subagentThreads)
      .map(([threadId, value]) => ({ threadId, ...deepClone(value), isSubagent: true }));
  }

  setSubagentThread(threadId, patch) {
    if (typeof threadId !== 'string' || !threadId || threadId === 'undefined') {
      throw new Error('A valid threadId is required for a Discord subagent thread.');
    }
    return this.update((state) => {
      state.subagentThreads[threadId] = {
        ...state.subagentThreads[threadId],
        ...patch,
        isSubagent: true,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  removeSubagentThread(threadId) {
    return this.update((state) => {
      delete state.subagentThreads[threadId];
    });
  }

  retainSubagentTurnRecords(threadId, turnIds) {
    if (!this.value.subagentThreads[threadId]) {
      throw new Error(`Unknown subagent thread binding: ${threadId}`);
    }
    const retained = new Set(turnIds ?? []);
    return this.update((state) => {
      state.subagentThreads[threadId].turnMessages ??= {};
      for (const turnId of Object.keys(state.subagentThreads[threadId].turnMessages)) {
        if (!retained.has(turnId)) delete state.subagentThreads[threadId].turnMessages[turnId];
      }
    });
  }

  turnRecord(threadId, turnId) {
    const owner = this.value.bindings[threadId] ?? this.value.subagentThreads[threadId];
    const value = owner?.turnMessages?.[turnId];
    return value ? deepClone(value) : null;
  }

  setTurnRecord(threadId, turnId, patch) {
    const collection = this.value.bindings[threadId]
      ? 'bindings'
      : this.value.subagentThreads[threadId]
        ? 'subagentThreads'
        : null;
    if (!collection) throw new Error(`Unknown thread binding: ${threadId}`);
    return this.update((state) => {
      state[collection][threadId].turnMessages ??= {};
      state[collection][threadId].turnMessages[turnId] = {
        ...state[collection][threadId].turnMessages[turnId],
        ...patch,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  clientToolRequest(key) {
    const value = this.value.clientToolRequests[key];
    return value ? deepClone(value) : null;
  }

  setClientToolRequest(key, patch) {
    if (typeof key !== 'string' || !key) throw new Error('A client tool request key is required.');
    return this.update((state) => {
      state.clientToolRequests ??= {};
      state.clientToolRequests[key] = {
        ...state.clientToolRequests[key],
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      const entries = Object.entries(state.clientToolRequests);
      if (entries.length > 2_000) {
        entries
          .sort(([, left], [, right]) => String(left.updatedAt).localeCompare(String(right.updatedAt)))
          .slice(0, entries.length - 2_000)
          .forEach(([oldKey]) => delete state.clientToolRequests[oldKey]);
      }
    });
  }

  projectCategory(projectKey) {
    const value = this.value.projectCategories[projectKey];
    return value ? deepClone(value) : null;
  }

  projectCategories() {
    return Object.entries(this.value.projectCategories)
      .map(([projectKey, value]) => ({ projectKey, ...deepClone(value) }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  setProjectCategory(projectKey, value) {
    return this.update((state) => {
      state.projectCategories[projectKey] = {
        ...state.projectCategories[projectKey],
        ...value,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  removeProjectCategory(projectKey) {
    return this.update((state) => {
      delete state.projectCategories[projectKey];
    });
  }

  setBinding(threadId, binding) {
    if (typeof threadId !== 'string' || !threadId || threadId === 'undefined') {
      throw new Error('A valid threadId is required for a Discord binding.');
    }
    if (this.value.subagentThreads[threadId] && !this.value.bindings[threadId]) {
      return this.setSubagentThread(threadId, binding);
    }
    return this.update((state) => {
      state.bindings[threadId] = { ...state.bindings[threadId], ...binding, updatedAt: new Date().toISOString() };
    });
  }

  removeBinding(threadId) {
    return this.update((state) => {
      delete state.bindings[threadId];
    });
  }

  setInfrastructure(infrastructure) {
    return this.update((state) => {
      state.infrastructure = { ...state.infrastructure, ...infrastructure };
    });
  }

  #write() {
    atomicWriteJson(this.filePath, this.value);
  }
}
