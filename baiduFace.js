const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

// 全局存储AccessToken（有效期30天，提前5分钟刷新）
let faceAccessToken = '';
let tokenExpireTime = 0;

/**
 * 1. 获取百度人脸识别AccessToken（API列表接口依赖此Token）
 */
async function getFaceAccessToken() {
  const now = Date.now();
  // 若Token有效，直接返回
  if (faceAccessToken && now < tokenExpireTime) {
    return faceAccessToken;
  }

  // 重新获取Token
  const response = await axios.get('https://aip.baidubce.com/oauth/2.0/token', {
    params: {
      grant_type: 'client_credentials',
      client_id: process.env.FACE_API_KEY,
      client_secret: process.env.FACE_SECRET_KEY
    }
  });

  faceAccessToken = response.data.access_token;
  tokenExpireTime = now + (response.data.expires_in - 300) * 1000; // 提前5分钟刷新
  return faceAccessToken;
}

/**
 * 2. 获取随机校验码（调用API列表中的“随机校验码”接口）
 */
async function getSessionCode() {
  const accessToken = await getFaceAccessToken();
  const response = await axios.post(
    `${process.env.FACE_SESSIONCODE_URL}?access_token=${accessToken}`,
    {},
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (response.data.error_code !== 0) {
    throw new Error(`随机校验码获取失败：${response.data.error_msg}`);
  }
  return response.data.result.session_code; // 返回校验码
}

/**
 * 3. 人脸搜索验证（调用API列表中的“人脸搜索V3”接口）
 * @param {string} imageBase64 - 人脸图片Base64编码（不含前缀）
 * @param {string} userGroup - 用户组（administrator/user）
 */
async function verifyFace(imageBase64, userGroup) {
  const accessToken = await getFaceAccessToken();
  const response = await axios.post(
    `${process.env.FACE_SEARCH_V3_URL}?access_token=${accessToken}`,
    {
      image: imageBase64,
      image_type: 'BASE64',
      group_id_list: userGroup,
      quality_control: 'NORMAL', // 质量控制：普通
      liveness_control: 'LOW'   // 活体控制：高（防止照片攻击）
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (response.data.error_code !== 0) {
    throw new Error(`人脸验证失败：${response.data.error_msg}`);
  }

  // 相似度评分≥80分视为验证通过（百度推荐阈值）
  const userList = response.data.result.user_list;
  if (userList.length === 0) return { success: false };
  return {
    success: userList[0].score >= 80,
    faceUserId: userList[0].user_id // 返回百度人脸库用户ID
  };
}


/**
 * 百度千帆V2版本 - BCE签名工具（核心：生成鉴权请求头）
 */
class BCEAuth {
  constructor(ak, sk) {
    this.ak = ak;
    this.sk = sk;
    this.service = 'qianfan'; // 固定服务名
    this.region = 'tj'; // 地域（默认bj，若你的Agent在其他地域需修改，如gz、sh）
  }

  // 生成ISO8601格式时间戳
  getTimestamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  // HMAC-SHA256签名
  hmacSha256(data, key) {
    return crypto.createHmac('sha256', key).update(data).digest('hex');
  }

  // 生成签名
  generateSignature(method, path, timestamp, nonce, contentMD5 = '', contentType = 'application/json') {
    // 1. 构造规范请求串
    const canonicalRequest = [
      method.toUpperCase(),
      path,
      '', // query参数（无则留空）
      `host:qianfan.baidubce.com`,
      `x-bce-date:${timestamp}`,
      `x-bce-nonce:${nonce}`,
      '', // 空行
      `content-md5:${contentMD5}`,
      `content-type:${contentType}`,
      'host;x-bce-date;x-bce-nonce' // 签名参数列表
    ].join('\n');

    // 2. 构造签名串
    const signKey = this.hmacSha256(`${timestamp.slice(0, 8)}T00:00:00Z/${this.service}/${this.region}/bce-auth-v1`, this.sk);
    const signature = this.hmacSha256(canonicalRequest, signKey);

    // 3. 构造Authorization头
    return `bce-auth-v1/${this.ak}/${timestamp}/${nonce}/${this.region}/${this.service}/sign/${signature}`;
  }
}

/**
 * 调用阿里云通义千问API生成智能回复
 */
async function generateAliyunQwenReply(formContent) {
  try {
    console.log('API_KEY配置:', process.env.ALIYUN_QWEN_API_KEY ? '已设置' : '未设置');
    console.log('APP_ID配置:', process.env.ALIYUN_QWEN_APP_ID ? '已设置' : '未设置');
    // 从环境变量获取配置（需提前在.env中设置）
    const API_KEY = process.env.ALIYUN_QWEN_API_KEY;
    const APP_ID = process.env.ALIYUN_QWEN_APP_ID;
    const API_BASE_URL = process.env.ALIYUN_QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';

    if (!API_KEY || !APP_ID) {
      throw new Error('请配置阿里云通义千问的API_KEY和APP_ID');
    }

    // 构建请求参数（符合通义千问API规范）
    const requestOptions = {
      url: API_BASE_URL,
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'X-DashScope-Application': APP_ID
      },
      data: {
        model: process.env.ALIYUN_QWEN_MODEL || 'qwen-plus',
        input: {
          messages: [
            {
  role: 'system',
  content: `你是一位专业的表单管理员，负责以友好且专业的方式对用户提交的表单进行回复。你的主要技能和职责如下：

1. 处理和回复用户表单：
   - 审查用户提交的表单内容，检查所有字段是否填写完整，确认信息是否准确无误
   - 对于不完整或有误的信息，提供明确反馈并指导用户修正
   - 回复需包含对用户的感谢、确认收到表单及下一步操作说明
   - 如需用户补充信息或进一步操作，需清晰指示操作方式

2. 解答用户疑问：
   - 回答用户关于表单填写、提交流程等方面的问题
   - 提供详细步骤指导，帮助用户顺利完成表单提交
   - 对于与表单无关的问题，礼貌告知正确咨询渠道

3. 处理特殊情况：
   - 对紧急或特殊需求迅速响应并提供解决方案
   - 遇到无法解决的问题时，及时向上级或相关部门汇报，并告知用户处理进度

注意事项：
- 仅处理与表单相关的内容，非表单相关咨询需引导用户通过其他渠道获取帮助
- 回复始终保持友好和专业态度
- 所有回复基于事实和公司政策，不提供虚假或误导性信息
- 如需调用外部工具或知识库，确保使用可靠来源并在回复中注明`
},
            {
              role: 'user',
              content: formContent
            }
          ]
        },
        parameters: {
          temperature: 0.7,
          max_tokens: 500,
          seed: Math.floor(Math.random() * 10000) // 增加随机性
        }
      }
    };

    // 发送请求
    const response = await axios(requestOptions);

    // 修正判断逻辑：通义千问成功响应会包含output.text
    if (response.data.output?.text) {
      return response.data.output.text;
    } else {
      throw new Error(`API返回异常: ${JSON.stringify(response.data)}`);
    }
  } catch (error) {
    console.error('阿里云通义千问调用失败:', error.response?.data || error.message);
    throw new Error(`智能回复生成失败：${error.message}`);
  }
}
module.exports = {
  getSessionCode,
  verifyFace,
  generateAliyunQwenReply
};