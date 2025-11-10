const mysql = require('mysql2/promise');
require('dotenv').config();

// 创建数据库连接池
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  connectionLimit: 10,
  waitForConnections: true
});

// 测试连接
pool.getConnection()
  .then(conn => {
    console.log('MySQL数据库连接成功');
    conn.release();
  })
  .catch(err => {
    console.error('MySQL数据库连接失败：', err.message);
  });

module.exports = pool;