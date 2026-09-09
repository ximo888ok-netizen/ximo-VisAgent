/**
 * seed-capabilities.ts — 种子能力卡导入
 *
 * 首次启动或用户手动「重置能力库」时调用。
 * 使用 INSERT OR IGNORE 保证幂等（同 id 不重复插入）。
 * 同时维护 FTS5 索引行。
 */
import type Database from 'better-sqlite3';
import type { CapabilityCreateRequest } from '../../shared/schemas/capability';
import { selectRow } from './query';

/** 种子能力卡定义 */
const SEED_CAPABILITIES: CapabilityCreateRequest[] = [
  {
    id: 'cap.excel.fill_column',
    title: '填充 Excel 列',
    description: '当用户需要将一列单元格按规则填充（如序号、公式、日期）时使用此能力卡。',
    tools: ['excel_read_range', 'excel_write_cell', 'ui_locate', 'ui_click'],
    precondition: '已打开目标 Excel 文件且目标列已确定',
    acceptance: '目标列所有行已正确填充，无空行遗漏',
    visualAnchors: [],
  },
  {
    id: 'cap.excel.read_table',
    title: '读取 Excel 表格',
    description: '从 Excel 区域中读取数据，转换为结构化表格供后续处理。',
    tools: ['excel_read_range', 'file_read'],
    precondition: '已打开目标 Excel 文件',
    acceptance: '成功读取指定区域的所有数据行',
    visualAnchors: [],
  },
  {
    id: 'cap.files.organize',
    title: '整理文件夹',
    description: '按规则（日期、类型、名称）将文件移动到对应子文件夹中。',
    tools: ['file_list', 'file_read', 'file_write'],
    precondition: '目标文件夹存在且可写',
    acceptance: '所有文件已按规则归入对应子文件夹',
    visualAnchors: [],
  },
  {
    id: 'cap.files.batch_rename',
    title: '批量重命名文件',
    description: '按命名规则（如日期前缀、序号、模板替换）对多个文件进行重命名。',
    tools: ['file_list', 'file_read', 'file_write'],
    precondition: '目标文件夹存在且文件可重命名',
    acceptance: '所有匹配文件已按规则重命名完成',
    visualAnchors: [],
  },
  {
    id: 'cap.app.launch_and_login',
    title: '启动应用并登录',
    description: '打开指定应用，若需要登录则完成登录流程（输入账号密码、处理验证码等）。',
    tools: ['open_app', 'activate_window', 'ui_locate', 'ui_click', 'keyboard_type'],
    precondition: '目标应用已安装，账号凭据已准备',
    acceptance: '应用已启动并处于已登录状态',
    visualAnchors: [],
  },
  {
    id: 'cap.browser.search_and_extract',
    title: '浏览器搜索并提取信息',
    description: '在浏览器中执行搜索查询，从结果页面提取所需信息。',
    tools: ['open_app', 'ui_locate', 'ui_click', 'keyboard_type', 'get_clipboard'],
    precondition: '浏览器已安装且可用',
    acceptance: '成功提取所需搜索结果信息',
    visualAnchors: [],
  },
  {
    id: 'cap.office.copy_paste',
    title: '跨应用复制粘贴',
    description: '从源应用中复制数据，切换到目标应用并粘贴。',
    tools: ['ui_locate', 'ui_click', 'keyboard_press', 'get_clipboard', 'set_clipboard'],
    precondition: '源应用和目标应用均已打开',
    acceptance: '数据已从源应用复制并粘贴到目标应用',
    visualAnchors: [],
  },
  {
    id: 'cap.wechat.send_message',
    title: '发送微信消息',
    description: '通过微信发送消息给指定联系人或群组。',
    tools: ['wechat_send', 'ui_locate', 'ui_click', 'keyboard_type'],
    precondition: '微信已登录且目标联系人存在',
    acceptance: '消息已成功发送到目标联系人',
    visualAnchors: [],
  },
  {
    id: 'cap.generic.look_and_act',
    title: '查看画面并操作',
    description: '通用能力卡：截屏查看当前画面，定位 UI 元素，执行点击或输入操作。',
    tools: ['look_close', 'ui_locate', 'ui_click', 'keyboard_type', 'mouse_click', 'mouse_scroll'],
    precondition: '目标窗口已在前台显示',
    acceptance: '完成用户指定的操作目标',
    visualAnchors: [],
  },
];

/** 将种子能力卡导入数据库（幂等：同 id 不覆盖） */
export function seedCapabilities(db: Database.Database): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;
  const now = Date.now();

  const insertSql = db.prepare(
    `INSERT OR IGNORE INTO capabilities
      (id, title, description, toolsJson, precondition, acceptance, visualAnchorsJson, status, source, usageCount, failCount, createdAt, updatedAt)
     VALUES (@id, @title, @description, @toolsJson, @precondition, @acceptance, @visualAnchorsJson, @status, @source, 0, 0, @createdAt, @updatedAt)`,
  );

  const ftsInsertSql = db.prepare(
    `INSERT OR IGNORE INTO capability_fts (capabilityId, title, description, precondition, acceptance)
     VALUES (@capabilityId, @title, @description, @precondition, @acceptance)`,
  );

  for (const cap of SEED_CAPABILITIES) {
    // 检查是否已存在
    const existing = selectRow<{ id: string }>(db, 'SELECT id FROM capabilities WHERE id = ?', [cap.id]);
    if (existing) {
      skipped++;
      continue;
    }

    insertSql.run({
      id: cap.id,
      title: cap.title,
      description: cap.description,
      toolsJson: JSON.stringify(cap.tools),
      precondition: cap.precondition,
      acceptance: cap.acceptance,
      visualAnchorsJson: JSON.stringify(cap.visualAnchors),
      status: 'active',
      source: 'seed',
      createdAt: now,
      updatedAt: now,
    });

    ftsInsertSql.run({
      capabilityId: cap.id,
      title: cap.title,
      description: cap.description,
      precondition: cap.precondition,
      acceptance: cap.acceptance,
    });

    imported++;
  }

  return { imported, skipped };
}
