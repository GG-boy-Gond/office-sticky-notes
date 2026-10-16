'use strict';

const DEFAULT_APPEARANCE = Object.freeze({
  backgroundColor: '#1a201d',
  backgroundOpacity: 91,
  textOpacity: 100,
  fontSize: 14,
  backgroundImage: '',
  imageName: '',
});

function validateAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('外观设置无效。');
  if (Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_APPEARANCE, key)))
    throw new Error('包含不支持的外观设置。');
  const appearance = { ...DEFAULT_APPEARANCE, ...value };
  if (!/^#[\da-f]{6}$/i.test(appearance.backgroundColor)) throw new Error('请选择有效的背景颜色。');
  for (const key of ['backgroundOpacity', 'textOpacity']) {
    if (!Number.isInteger(appearance[key]) || appearance[key] < 0 || appearance[key] > 100)
      throw new Error('透明度必须为 0 到 100 之间的整数。');
  }
  if (
    !Number.isInteger(appearance.fontSize) ||
    appearance.fontSize < 10 ||
    appearance.fontSize > 36
  )
    throw new Error('字体大小必须为 10 到 36 之间的整数。');
  if (
    typeof appearance.backgroundImage !== 'string' ||
    appearance.backgroundImage.length > 6 * 1024 * 1024 ||
    (appearance.backgroundImage !== '' &&
      !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(appearance.backgroundImage))
  )
    throw new Error('背景图片格式或大小无效。');
  if (typeof appearance.imageName !== 'string' || appearance.imageName.length > 255)
    throw new Error('图片名称无效。');
  return appearance;
}

module.exports = { DEFAULT_APPEARANCE, validateAppearance };
