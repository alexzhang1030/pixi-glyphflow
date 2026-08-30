#include <emscripten/emscripten.h>

#include <hb-gpu.h>
#include <hb-ot.h>

#include <stdint.h>
#include <string.h>

namespace {

constexpr uint32_t kAbiVersion = 1;

enum EncodeStatus : int32_t {
  kEncodeOk = 0,
  kEncodeInvalidArgument = 1,
  kEncodeDrawFailed = 2,
  kEncodeBlobFailed = 3,
  kEncodeBlobAlignmentFailed = 4,
};

struct EncodeResult {
  uint32_t data;
  uint32_t length;
  int32_t x_bearing;
  int32_t y_bearing;
  int32_t width;
  int32_t height;
  uint32_t upem;
};

static_assert(sizeof(EncodeResult) == 28, "Hb GPU encoder result ABI changed");

struct FontHandle {
  hb_blob_t *font_blob = nullptr;
  hb_face_t *face = nullptr;
  hb_font_t *font = nullptr;
  hb_gpu_draw_t *draw = nullptr;
  hb_blob_t *result_blob = nullptr;
  unsigned upem = 0;
  bool counted = false;
};

uint32_t live_fonts = 0;
uint32_t live_results = 0;
const char *last_error = "";

void set_error(const char *message) { last_error = message; }

void clear_result(FontHandle *handle) {
  if (handle == nullptr || handle->result_blob == nullptr) return;
  hb_gpu_draw_recycle_blob(handle->draw, handle->result_blob);
  handle->result_blob = nullptr;
  live_results--;
}

void destroy_handle(FontHandle *handle) {
  if (handle == nullptr) return;
  clear_result(handle);
  hb_gpu_draw_destroy(handle->draw);
  hb_font_destroy(handle->font);
  hb_face_destroy(handle->face);
  hb_blob_destroy(handle->font_blob);
  if (handle->counted) live_fonts--;
  delete handle;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE uint32_t hb_gpu_encoder_abi_version() { return kAbiVersion; }

EMSCRIPTEN_KEEPALIVE const char *hb_gpu_encoder_harfbuzz_version() {
  return hb_version_string();
}

EMSCRIPTEN_KEEPALIVE uint32_t hb_gpu_encoder_result_size() { return sizeof(EncodeResult); }

EMSCRIPTEN_KEEPALIVE const char *hb_gpu_encoder_last_error() { return last_error; }

EMSCRIPTEN_KEEPALIVE uint32_t hb_gpu_encoder_live_fonts() { return live_fonts; }

EMSCRIPTEN_KEEPALIVE uint32_t hb_gpu_encoder_live_results() { return live_results; }

EMSCRIPTEN_KEEPALIVE FontHandle *hb_gpu_encoder_create(const uint8_t *font_data,
                                                       uint32_t font_length,
                                                       uint32_t face_index) {
  set_error("");
  if (font_data == nullptr || font_length == 0) {
    set_error("font bytes are empty");
    return nullptr;
  }

  FontHandle *handle = new FontHandle();
  if (handle == nullptr) {
    set_error("font handle allocation failed");
    return nullptr;
  }
  handle->font_blob = hb_blob_create(reinterpret_cast<const char *>(font_data), font_length,
                                     HB_MEMORY_MODE_DUPLICATE, nullptr, nullptr);
  if (handle->font_blob == nullptr || hb_blob_get_length(handle->font_blob) != font_length) {
    set_error("font blob allocation failed");
    destroy_handle(handle);
    return nullptr;
  }
  handle->face = hb_face_create(handle->font_blob, face_index);
  if (handle->face == nullptr || hb_face_get_glyph_count(handle->face) == 0) {
    set_error("font face is invalid or empty");
    destroy_handle(handle);
    return nullptr;
  }
  handle->font = hb_font_create(handle->face);
  if (handle->font == nullptr) {
    set_error("font allocation failed");
    destroy_handle(handle);
    return nullptr;
  }
  hb_ot_font_set_funcs(handle->font);
  handle->upem = hb_face_get_upem(handle->face);
  if (handle->upem == 0) handle->upem = 1000;
  hb_font_set_scale(handle->font, static_cast<int>(handle->upem),
                    static_cast<int>(handle->upem));
  handle->draw = hb_gpu_draw_create_or_fail();
  if (handle->draw == nullptr) {
    set_error("GPU draw encoder allocation failed");
    destroy_handle(handle);
    return nullptr;
  }

  handle->counted = true;
  live_fonts++;
  return handle;
}

EMSCRIPTEN_KEEPALIVE void hb_gpu_encoder_destroy(FontHandle *handle) {
  destroy_handle(handle);
}

EMSCRIPTEN_KEEPALIVE void hb_gpu_encoder_clear_result(FontHandle *handle) {
  clear_result(handle);
}

EMSCRIPTEN_KEEPALIVE int32_t hb_gpu_encoder_encode(FontHandle *handle, uint32_t glyph_id,
                                                   EncodeResult *result) {
  set_error("");
  if (handle == nullptr || handle->draw == nullptr || handle->font == nullptr ||
      result == nullptr) {
    set_error("encode arguments are invalid");
    return kEncodeInvalidArgument;
  }

  clear_result(handle);
  memset(result, 0, sizeof(*result));
  const bool draw_succeeded = hb_gpu_draw_glyph_or_fail(handle->draw, handle->font, glyph_id);
  hb_glyph_extents_t extents = {};
  hb_blob_t *blob = hb_gpu_draw_encode(handle->draw, &extents);
  if (!draw_succeeded) {
    if (blob != nullptr) hb_gpu_draw_recycle_blob(handle->draw, blob);
    set_error("glyph outline draw failed");
    return kEncodeDrawFailed;
  }
  if (blob == nullptr) {
    set_error("packed curve blob encode failed");
    return kEncodeBlobFailed;
  }

  unsigned length = 0;
  const char *data = hb_blob_get_data(blob, &length);
  if (length % 8 != 0) {
    hb_gpu_draw_recycle_blob(handle->draw, blob);
    set_error("packed curve blob contains a partial RGBA16I texel");
    return kEncodeBlobAlignmentFailed;
  }

  handle->result_blob = blob;
  live_results++;
  result->data = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(data));
  result->length = length;
  result->x_bearing = extents.x_bearing;
  result->y_bearing = extents.y_bearing;
  result->width = extents.width;
  result->height = extents.height;
  result->upem = handle->upem;
  return kEncodeOk;
}

}  // extern "C"
