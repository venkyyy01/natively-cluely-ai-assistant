#include <napi.h>

#if defined(__APPLE__)
#include <pthread.h>
#endif

static Napi::Value SetCurrentThreadQoS(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

#if defined(__APPLE__)
  if (info.Length() > 0 && info[0].IsString()) {
    std::string qos = info[0].As<Napi::String>().Utf8Value();
    qos_class_t qosClass = QOS_CLASS_BACKGROUND;

    if (qos == "USER_INTERACTIVE") {
      qosClass = QOS_CLASS_USER_INTERACTIVE;
    } else if (qos == "USER_INITIATED") {
      qosClass = QOS_CLASS_USER_INITIATED;
    }

    pthread_set_qos_class_self_np(qosClass, 0);
  }
#endif

  return env.Undefined();
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("setCurrentThreadQoS", Napi::Function::New(env, SetCurrentThreadQoS));
  return exports;
}

NODE_API_MODULE(qos_helper, Init)
