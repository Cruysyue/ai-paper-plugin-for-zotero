"use strict";

var AIPaperHistory = class {
  constructor(directory) {
    this.directory = directory;
    this.records = new Map();
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.unreadableCount = 0;
  }

  copy(value) {
    // Share immutable strings, including image data, between copies of a record.
    if (Array.isArray(value)) return value.map(entry => this.copy(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.copy(entry)]));
    }
    return value;
  }

  async init() {
    await IOUtils.makeDirectory(this.directory, { ignoreExisting: true, createAncestors: true });
    const paths = (await IOUtils.getChildren(this.directory)).filter(path => path.endsWith(".json"));
    const loaded = await Promise.allSettled(paths.map(path => IOUtils.readJSON(path)));
    for (let index = 0; index < loaded.length; index++) {
      try {
        if (loaded[index].status === "rejected") throw loaded[index].reason;
        const conversation = AIPaperCore.validateConversation(loaded[index].value);
        if (PathUtils.filename(paths[index]) !== conversation.id + ".json") throw new Error("会话文件名称与 ID 不符。 ");
        let recovered = false;
        for (const turn of conversation.turns) {
          if (turn.state === "pending") {
            turn.state = "cancelled";
            turn.errorMessage = "上次请求在应用关闭时中断。";
            recovered = true;
          }
        }
        this.records.set(conversation.id, conversation);
        if (recovered) await this.write(conversation);
      }
      catch (error) { this.unreadableCount++; Zotero.logError(error); }
    }
  }

  list(context) {
    return Array.from(this.records.values())
      .filter(record => !context || (record.paper.libraryID === context.item.libraryID
        && record.paper.itemKey === context.item.key
        && (!context.attachment || !record.paper.attachmentKey || record.paper.attachmentKey === context.attachment.key)))
      .sort((left, right) => Number(!!right.pinned) - Number(!!left.pinned)
        || right.updatedAt.localeCompare(left.updatedAt))
      .map(record => this.copy(record));
  }

  get(id) {
    const record = this.records.get(id);
    if (!record) throw new Error("会话记录不存在。 ");
    return this.copy(record);
  }

  setPinned(id, pinned) {
    return this.enqueue(async () => {
      const record = this.get(id);
      record.pinned = !!pinned;
      return this.commit(record);
    });
  }

  remove(id) {
    return this.enqueue(async () => {
      if (!this.records.has(id)) return;
      await IOUtils.remove(PathUtils.join(this.directory, id + ".json"), { ignoreAbsent: true });
      this.records.delete(id);
      for (const listener of this.listeners) {
        try { listener({ id, deleted: true }); }
        catch (error) { Zotero.logError(error); }
      }
    });
  }

  async write(record) {
    AIPaperCore.validateConversation(record);
    const path = PathUtils.join(this.directory, record.id + ".json");
    await IOUtils.writeJSON(path, record, { tmpPath: path + ".tmp" });
  }

  enqueue(action) {
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {});
    return operation;
  }

  async commit(record) {
    record = this.copy(record);
    delete record.unsaved;
    await this.write(record);
    return this.publish(record);
  }

  publish(record) {
    this.records.set(record.id, this.copy(record));
    for (const listener of this.listeners) {
      try { listener(this.copy(record)); }
      catch (error) { Zotero.logError(error); }
    }
    return this.copy(record);
  }

  begin(context, id, question, files = [], parentTurnID, images = []) {
    return this.enqueue(async () => {
      const now = new Date().toISOString();
      const record = id ? this.get(id) : {
        schemaVersion: 1,
        id: "chat-" + AIPaperCore.uniqueID(),
        title: question.replace(/\s+/g, " ").slice(0, 70),
        paper: {
          libraryID: context.item.libraryID,
          itemKey: context.item.key,
          attachmentKey: context.attachment?.key || null,
          title: context.item.getField("title") || "未命名论文"
        },
        createdAt: now,
        updatedAt: now,
        turns: []
      };
      if (record.paper.libraryID !== context.item.libraryID || record.paper.itemKey !== context.item.key) {
        throw new Error("会话与当前论文不匹配，请新建会话。 ");
      }
      const parent = parentTurnID === undefined ? record.turns.at(-1) : record.turns.find(turn => turn.id === parentTurnID);
      if (!parent && (record.turns.length || parentTurnID != null)) throw new Error("分支起点已不存在，请重新打开会话。 ");
      if (parent?.state === "pending") throw new Error("当前分支正在生成回答。 ");
      const turn = {
        id: AIPaperCore.uniqueID(), parentTurnID: parent?.id ?? null,
        question, answer: null, state: "pending", createdAt: now
      };
      if (files.length) turn.files = this.copy(files);
      if (images.length) turn.images = this.copy(images);
      record.turns.push(turn);
      record.updatedAt = now;
      return { conversation: await this.commit(record), turnID: turn.id };
    });
  }

  finish(id, turnID, result, task) {
    return this.enqueue(async () => {
      if (!this.records.has(id)) return null;
      const record = this.get(id);
      const turn = record.turns.find(entry => entry.id === turnID);
      if (!turn || turn.state !== "pending") return record;
      const cancelled = task?.cancelled;
      Object.assign(turn, cancelled ? { state: "cancelled", answer: null, errorMessage: "已停止生成。" } : result);
      turn.completedAt = new Date().toISOString();
      record.updatedAt = turn.completedAt;
      if (result.attachmentKey && !cancelled) record.paper.attachmentKey = result.attachmentKey;
      delete turn.attachmentKey;
      try { return await this.commit(record); }
      catch (_) {
        record.unsaved = true;
        const error = new Error("会话本地写入失败，当前内容可复制。恢复磁盘写入后继续提问会再次保存。 ");
        error.conversation = this.publish(record);
        throw error;
      }
    });
  }

  flush() {
    return this.enqueue(async () => {
      for (const record of this.records.values()) {
        if (record.unsaved) await this.commit(record);
      }
    });
  }

  importLegacy(id, paper, result) {
    return this.enqueue(async () => {
      if (this.records.has(id)) return;
      const createdAt = Number.isFinite(Date.parse(result.createdAt)) ? result.createdAt : new Date().toISOString();
      await this.commit({
        schemaVersion: 1, id, title: result.question || "论文总结", paper,
        createdAt, updatedAt: createdAt,
        turns: [{
          id: id + "-turn", question: result.question || "总结这篇论文", answer: result.text,
          state: "complete", createdAt, completedAt: createdAt,
          source: result.source || "历史总结", model: result.model || "", skillName: result.skillName || "",
          outputTruncated: !!result.outputTruncated, usage: result.usage || null
        }]
      });
    });
  }
};
