const { createFairyDiagnostics } = require('../../../../fairy-contracts/client-diagnostics.cjs');

const diagnostics = createFairyDiagnostics('dsh-fairy-visual');

function settingError(field, error) {
  diagnostics.error('settings.persist', error, { field });
}

function setControllerSetting(controller, field, value) {
  try {
    return Promise.resolve(controller.set(field, value));
  } catch (error) {
    return Promise.reject(error);
  }
}

function saveControllerSetting(controller, field, value) {
  return setControllerSetting(controller, field, value).catch((error) => {
    settingError(field, error);
    return undefined;
  });
}

module.exports = { setControllerSetting, saveControllerSetting, settingError };
