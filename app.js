const express = require('express');
const cors = require('cors');
const pool = require('./db');
const { getSessionCode, verifyFace, generateAliyunQwenReply } = require('./baiduFace');
require('dotenv').config();

const app = express();
// 跨域配置
app.use(cors());
// 解析JSON请求（支持大文件Base64）
app.use(express.json({ limit: '20mb' }));

/**d:d:
 * 1. 获取随机校验码（用于活体检测前置校验）
 */
app.get('/api/face/session-code', async (req, res) => {
  try {
    const sessionCode = await getSessionCode();
    res.json({ success: true, sessionCode });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 2. 人脸识别验证接口（支持管理员/普通用户）
 */
app.post('/api/face/verify', async (req, res) => {
  try {
    const { imageBase64, userType } = req.body;
    // 确定用户组（从API列表文档的用户组配置）
    const userGroup = userType === 'admin' 
      ? process.env.FACE_USER_GROUP_ADMIN 
      : process.env.FACE_USER_GROUP_USER;
    
    // 调用百度人脸搜索V3接口验证
    const verifyResult = await verifyFace(imageBase64, userGroup);
    if (!verifyResult.success) {
      return res.json({ success: false, message: '人脸不匹配或未注册' });
    }

    // 从数据库查询用户信息
    const [users] = await pool.execute(
      'SELECT id, user_group FROM users WHERE face_user_id = ?',
      [verifyResult.faceUserId]
    );

    if (users.length === 0) {
      return res.json({ success: false, message: '用户未关联系统账号' });
    }

    res.json({
      success: true,
      userId: users[0].id, // 系统用户ID
      userGroup: users[0].user_group // 用户组
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 3. 提交表单接口（普通用户）
 */
app.post('/api/form/submit', async (req, res) => {
  try {
    const { title, content, category, userId, ipAddress, browserInfo } = req.body;
    // 生成唯一表单编号
    const formNo = `FORM-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;

    // 插入表单数据
    const [result] = await pool.execute(
      `INSERT INTO forms (form_no, user_id, title, content, category, ip_address, browser_info) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [formNo, userId, title, content, category, ipAddress, browserInfo]
    );

    res.json({ success: true, formId: result.insertId, formNo });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 4. 获取用户表单列表（普通用户）
 */
app.get('/api/forms/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const [forms] = await pool.execute(
      `SELECT f.*, r.content as reply_content, r.create_time as reply_time 
       FROM forms f 
       LEFT JOIN replies r ON f.id = r.form_id 
       WHERE f.user_id = ? 
       ORDER BY f.create_time DESC`,
      [userId]
    );

    res.json({ success: true, data: forms });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 5. 获取所有表单（管理员）
 */
app.get('/api/forms/admin', async (req, res) => {
  try {
    const [forms] = await pool.execute(
      `SELECT f.*, r.content as reply_content, r.create_time as reply_time, u.face_user_id 
       FROM forms f 
       LEFT JOIN replies r ON f.id = r.form_id 
       LEFT JOIN users u ON f.user_id = u.id 
       ORDER BY f.create_time DESC`
    );

    res.json({ success: true, data: forms });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 6. 生成智能回复（管理员）
 */
app.post('/api/reply/generate', async (req, res) => {
  try {
    const { formContent } = req.body;
    const reply = await generateAliyunQwenReply(formContent);
    res.json({ success: true, reply });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 7. 提交回复（管理员）
 */
app.post('/api/reply/submit', async (req, res) => {
  try {
    const { formId, adminId, content } = req.body;

    // 1. 插入回复
    await pool.execute(
      'INSERT INTO replies (form_id, admin_id, content) VALUES (?, ?, ?)',
      [formId, adminId, content]
    );

    // 2. 更新表单状态为“已回复”
    await pool.execute(
      'UPDATE forms SET status = ? WHERE id = ?',
      ['已回复', formId]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 8. 删除表单（管理员）
 */
app.delete('/api/form/:formId', async (req, res) => {
  try {
    const { formId } = req.params;
    await pool.execute('DELETE FROM forms WHERE id = ?', [formId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`后端服务启动成功，端口：${PORT}`);
  console.log(`API文档地址：http://localhost:${PORT}/api-docs`);
});