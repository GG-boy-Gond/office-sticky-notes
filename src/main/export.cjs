'use strict';

const ExcelJS = require('exceljs');

function createWorkbook(state) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Office Notes';
  const todo = workbook.addWorksheet('todo list');
  todo.columns = [
    { header: '内容', key: 'content', width: 60 },
    { header: '建立时间', key: 'createdAt', width: 23 },
  ];
  todo.addRows(state.todos.map(({ content, createdAt }) => ({ content, createdAt })));
  const done = workbook.addWorksheet('done list');
  done.columns = [
    { header: '内容', key: 'content', width: 60 },
    { header: '建立时间', key: 'createdAt', width: 23 },
    { header: '完成时间', key: 'completedAt', width: 23 },
  ];
  done.addRows([...state.done].sort((a, b) => b.completedAt.localeCompare(a.completedAt)));
  for (const sheet of [todo, done]) {
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: `${sheet === todo ? 'B' : 'C'}1` };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3D665A' } };
    sheet.eachRow((row) => {
      row.alignment = { vertical: 'top', wrapText: true };
    });
  }
  return workbook;
}

module.exports = { createWorkbook };
