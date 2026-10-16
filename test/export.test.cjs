'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { createWorkbook } = require('../src/main/export.cjs');

test('Excel roundtrip preserves Chinese content, order, dates, and literal formula-like text', async () => {
  const workbook = createWorkbook({
    todos: [
      { content: '复查合同 & 付款', createdAt: '2026-10-15 10:00:00' },
      { content: '=1+1', createdAt: '2026-10-15 11:00:00' },
    ],
    done: [
      { content: '整理报告', createdAt: '2026-10-14 10:00:00', completedAt: '2026-10-15 12:00:00' },
    ],
  });
  const buffer = await workbook.xlsx.writeBuffer();
  const read = new ExcelJS.Workbook();
  await read.xlsx.load(buffer);
  assert.equal(read.worksheets.length, 2);
  assert.equal(read.getWorksheet('todo list').getCell('A2').value, '复查合同 & 付款');
  assert.equal(read.getWorksheet('todo list').getCell('A3').value, '=1+1');
  assert.equal(read.getWorksheet('todo list').getCell('A3').type, ExcelJS.ValueType.String);
  assert.equal(read.getWorksheet('done list').getCell('C2').value, '2026-10-15 12:00:00');
});
