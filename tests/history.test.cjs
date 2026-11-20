const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const core = require("../addon/content/core.js");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-paper-history-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const errors = [];
  const io = {
    makeDirectory: directory => fs.mkdir(directory, { recursive: true }),
    getChildren: async directory => (await fs.readdir(directory)).map(name => path.join(directory, name)),
    readJSON: async filename => JSON.parse(await fs.readFile(filename, "utf8")),
    remove: filename => fs.rm(filename, { force: true }),
    writeJSON: async (filename, value, { tmpPath }) => {
      await fs.writeFile(tmpPath, JSON.stringify(value));
      await fs.rename(tmpPath, filename);
    }
  };
  const sandbox = { IOUtils: io, PathUtils: { join: path.join, filename: path.basename }, AIPaperCore: core,
    Zotero: { logError: error => errors.push(error) } };
  const source = await fs.readFile(path.join(__dirname, "../addon/content/history.js"), "utf8");
  vm.runInNewContext(source + "\nthis.History = AIPaperHistory;", sandbox);
  const history = new sandbox.History(directory);
  await history.init();
  const context = { item: { libraryID: 1, key: "ABCD2345", getField: () => "测试论文" }, attachment: null };
  return { history, History: sandbox.History, directory, context, io, errors };
}

test("conversation persistence retains question, answer and paper identity", async t => {
  const { history, History, directory, context } = await fixture(t);
  const started = await history.begin(context, null, "研究结论是什么？");
  await history.finish(started.conversation.id, started.turnID, { state: "complete", answer: "有依据的回答" });
  const reopened = new History(directory);
  await reopened.init();
  const record = reopened.get(started.conversation.id);
  assert.equal(record.paper.itemKey, "ABCD2345");
  assert.equal(record.turns[0].answer, "有依据的回答");
});

test("concurrent sends on the same default path allow one pending turn", async t => {
  const { history, context } = await fixture(t);
  const first = await history.begin(context, null, "第一个问题");
  await history.finish(first.conversation.id, first.turnID, { state: "complete", answer: "回答" });
  const outcomes = await Promise.allSettled([
    history.begin(context, first.conversation.id, "问题A"),
    history.begin(context, first.conversation.id, "问题B")
  ]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(history.get(first.conversation.id).turns.filter(turn => turn.state === "pending").length, 1);
});

test("legacy linear conversations support a fork and keep both paths after restart", async t => {
  const { history, History, directory, context } = await fixture(t);
  const root = await history.begin(context, null, "原始问题");
  const id = root.conversation.id;
  await history.finish(id, root.turnID, { state: "complete", answer: "原始回答" });
  const main = await history.begin(context, id, "原路径追问");
  await history.finish(id, main.turnID, { state: "complete", answer: "原路径回答" });
  const legacy = history.get(id);
  for (const turn of legacy.turns) delete turn.parentTurnID;
  await history.write(legacy);

  const upgraded = new History(directory);
  await upgraded.init();
  const branch = await upgraded.begin(context, id, "分支问题", [], root.turnID);
  await upgraded.finish(id, branch.turnID, { state: "complete", answer: "分支回答" });
  const reopened = new History(directory);
  await reopened.init();
  const record = reopened.get(id);
  assert.equal(record.turns.length, 3);
  assert.deepEqual(core.turnPath(record.turns, main.turnID).map(turn => turn.question), ["原始问题", "原路径追问"]);
  assert.deepEqual(core.turnPath(record.turns, branch.turnID).map(turn => turn.question), ["原始问题", "分支问题"]);
});

test("parallel branches can complete or stop independently", async t => {
  const { history, context } = await fixture(t);
  const root = await history.begin(context, null, "原始问题");
  const id = root.conversation.id;
  await history.finish(id, root.turnID, { state: "complete", answer: "原始回答" });
  const [first, second] = await Promise.all([
    history.begin(context, id, "分支甲", [], root.turnID),
    history.begin(context, id, "分支乙", [], root.turnID)
  ]);
  await history.finish(id, second.turnID, { state: "complete", answer: "分支乙的回答" });
  await history.finish(id, first.turnID, { state: "complete", answer: "不应保存" }, { cancelled: true });
  const { turns } = history.get(id);
  assert.equal(core.turnPath(turns, first.turnID).at(-1).state, "cancelled");
  assert.equal(core.turnPath(turns, second.turnID).at(-1).answer, "分支乙的回答");
});

test("a branch requires an existing ancestor in the same conversation", async t => {
  const { history, context } = await fixture(t);
  const root = await history.begin(context, null, "有效问题");
  await assert.rejects(history.begin(context, root.conversation.id, "分支", [], "missing-turn"), /分支起点/);
  const record = history.get(root.conversation.id);
  assert.equal(record.turns.length, 1);
  record.turns[0].parentTurnID = root.turnID;
  assert.throws(() => core.validateConversation(record), /分支关系/);
});

test("cancellation prevents a late successful response from being committed", async t => {
  const { history, context } = await fixture(t);
  const started = await history.begin(context, null, "取消的问题");
  const record = await history.finish(started.conversation.id, started.turnID,
    { state: "complete", answer: "迟到的回答" }, { cancelled: true });
  assert.equal(record.turns[0].state, "cancelled");
  assert.equal(record.turns[0].answer, null);
  await history.finish(record.id, started.turnID, { state: "complete", answer: "再次迟到" });
  assert.equal(history.get(record.id).turns[0].answer, null);
});

test("restart recovers interrupted requests without losing the question", async t => {
  const { history, History, directory, context } = await fixture(t);
  const started = await history.begin(context, null, "应用关闭前的问题");
  const reopened = new History(directory);
  await reopened.init();
  const turn = reopened.get(started.conversation.id).turns[0];
  assert.equal(turn.state, "cancelled");
  assert.equal(turn.question, "应用关闭前的问题");
});

test("failed disk writes leave memory consistent and allow a safe retry", async t => {
  const { history, context, io } = await fixture(t);
  const write = io.writeJSON;
  io.writeJSON = async () => { throw new Error("Disk full"); };
  await assert.rejects(history.begin(context, null, "写入失败的问题"), /Disk full/);
  assert.equal(history.list().length, 0);
  io.writeJSON = write;
  await history.begin(context, null, "重试问题");
  assert.equal(history.list().length, 1);
});

test("legacy summary migration is idempotent and corrupt files do not hide valid history", async t => {
  const { history, History, directory, errors } = await fixture(t);
  const paper = { libraryID: 1, itemKey: "ABCD2345", attachmentKey: null, title: "旧版论文" };
  const summary = { text: "旧版总结", question: "总结论文", createdAt: new Date().toISOString() };
  await history.importLegacy("legacy-summary", paper, summary);
  await history.importLegacy("legacy-summary", paper, summary);
  assert.equal(history.list().length, 1);
  await fs.writeFile(path.join(directory, "corrupt.json"), "bad JSON");
  const reopened = new History(directory);
  await reopened.init();
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.unreadableCount, 1);
  assert.equal(errors.length, 1);
});

test("a failed final write retains the answer and the next turn retries persistence", async t => {
  const { history, History, directory, context, io } = await fixture(t);
  const first = await history.begin(context, null, "第一个问题");
  const write = io.writeJSON;
  io.writeJSON = async () => { throw new Error("Disk full"); };
  await assert.rejects(history.finish(first.conversation.id, first.turnID, { state: "complete", answer: "已生成的回答" }),
    error => error.conversation.turns[0].answer === "已生成的回答");
  assert.equal(history.get(first.conversation.id).turns[0].state, "complete");
  io.writeJSON = write;
  await history.begin(context, first.conversation.id, "继续提问");
  const reopened = new History(directory);
  await reopened.init();
  assert.equal(reopened.get(first.conversation.id).turns[0].answer, "已生成的回答");
  assert.equal(reopened.get(first.conversation.id).unsaved, undefined);
});

test("pinning persists and finishing a pending turn preserves pinned order", async t => {
  const { history, History, directory, context } = await fixture(t);
  const first = await history.begin(context, null, "需要置顶");
  const second = await history.begin(context, null, "另一会话");
  await history.setPinned(first.conversation.id, true);
  await history.finish(first.conversation.id, first.turnID, { state: "complete", answer: "回答" });
  await history.finish(second.conversation.id, second.turnID, { state: "complete", answer: "较新的回答" });
  const newer = history.get(second.conversation.id);
  newer.updatedAt = new Date(Date.parse(history.get(first.conversation.id).updatedAt) + 1000).toISOString();
  await history.commit(newer);
  assert.equal(history.list()[0].id, first.conversation.id);
  const reopened = new History(directory);
  await reopened.init();
  assert.equal(reopened.list()[0].pinned, true);
  await reopened.setPinned(first.conversation.id, false);
  assert.equal(reopened.list()[0].id, second.conversation.id);
});

test("deleting pending history prevents late answers and survives restart", async t => {
  const { history, History, directory, context } = await fixture(t);
  const first = await history.begin(context, null, "删除正在生成的会话");
  const events = [];
  history.listeners.add(record => events.push(record));
  await history.remove(first.conversation.id);
  assert.equal(await history.finish(first.conversation.id, first.turnID, { state: "complete", answer: "迟到回答" }), null);
  assert.equal(history.list().length, 0);
  assert.equal(events[0].deleted, true);
  const reopened = new History(directory);
  await reopened.init();
  assert.equal(reopened.list().length, 0);
});

test("failed deletion retains the conversation and permits retry", async t => {
  const { history, context, io } = await fixture(t);
  const first = await history.begin(context, null, "保留记录");
  const remove = io.remove;
  io.remove = async () => { throw new Error("Read only"); };
  await assert.rejects(history.remove(first.conversation.id));
  assert.equal(history.list().length, 1);
  io.remove = remove;
  await history.remove(first.conversation.id);
  assert.equal(history.list().length, 0);
});

test("attached file context persists across a conversation restart", async t => {
  const { history, History, directory, context } = await fixture(t);
  const files = core.prepareFiles([{ name: "补充资料.txt", text: "实验数据" }], 1000);
  const first = await history.begin(context, null, "比较资料", files);
  await history.finish(first.conversation.id, first.turnID, { state: "complete", answer: "比较结果" });
  const reopened = new History(directory);
  await reopened.init();
  assert.equal(reopened.get(first.conversation.id).turns[0].files[0].text, "实验数据");
});
