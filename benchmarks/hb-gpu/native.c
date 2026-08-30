#include <hb-gpu.h>
#include <hb-ot.h>

#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct {
  hb_codepoint_t glyph_id;
  unsigned blob_bytes;
  uint64_t encode_ns;
  unsigned char *blob_data;
  hb_glyph_extents_t extents;
  bool draw_succeeded;
} glyph_sample_t;

static uint64_t monotonic_ns(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
  return (uint64_t)value.tv_sec * UINT64_C(1000000000) + (uint64_t)value.tv_nsec;
}

static int compare_codepoints(const void *left, const void *right) {
  hb_codepoint_t a = *(const hb_codepoint_t *)left;
  hb_codepoint_t b = *(const hb_codepoint_t *)right;
  return (a > b) - (a < b);
}

static bool contains_glyph(const hb_codepoint_t *glyphs, unsigned count, hb_codepoint_t glyph) {
  for (unsigned index = 0; index < count; index++) {
    if (glyphs[index] == glyph) return true;
  }
  return false;
}

static void print_hex(const unsigned char *data, unsigned length) {
  static const char digits[] = "0123456789abcdef";
  for (unsigned index = 0; index < length; index++) {
    unsigned byte = data[index];
    putchar(digits[byte >> 4]);
    putchar(digits[byte & 0x0f]);
  }
}

static void print_json_string(const char *value) {
  putchar('"');
  if (value != NULL) {
    for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor++) {
      switch (*cursor) {
        case '"':
          fputs("\\\"", stdout);
          break;
        case '\\':
          fputs("\\\\", stdout);
          break;
        case '\b':
          fputs("\\b", stdout);
          break;
        case '\f':
          fputs("\\f", stdout);
          break;
        case '\n':
          fputs("\\n", stdout);
          break;
        case '\r':
          fputs("\\r", stdout);
          break;
        case '\t':
          fputs("\\t", stdout);
          break;
        default:
          if (*cursor < 0x20) {
            printf("\\u%04x", *cursor);
          } else {
            putchar(*cursor);
          }
          break;
      }
    }
  }
  putchar('"');
}

static size_t source_bytes(const char *source) { return source == NULL ? 0 : strlen(source); }

static void free_samples(glyph_sample_t *samples, unsigned count) {
  if (samples == NULL) return;
  for (unsigned index = 0; index < count; index++) free(samples[index].blob_data);
  free(samples);
}

static int fail(const char *message) {
  fprintf(stderr, "%s\n", message);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 4) return fail("usage: hb-gpu-native <font-file> <utf8-text> <iterations>");

  char *iteration_end = NULL;
  unsigned long parsed_iterations = strtoul(argv[3], &iteration_end, 10);
  if (iteration_end == argv[3] || *iteration_end != '\0' || parsed_iterations == 0 ||
      parsed_iterations > UINT32_MAX) {
    return fail("iterations must be a positive uint32");
  }
  unsigned iterations = (unsigned)parsed_iterations;

  hb_blob_t *font_blob = hb_blob_create_from_file_or_fail(argv[1]);
  if (font_blob == NULL) return fail("font file could not be opened");
  hb_face_t *face = hb_face_create(font_blob, 0);
  hb_font_t *font = hb_font_create(face);
  hb_ot_font_set_funcs(font);
  unsigned upem = hb_face_get_upem(face);
  if (upem == 0) upem = 1000;
  hb_font_set_scale(font, (int)upem, (int)upem);

  hb_buffer_t *buffer = hb_buffer_create();
  hb_buffer_add_utf8(buffer, argv[2], -1, 0, -1);
  hb_buffer_guess_segment_properties(buffer);
  uint64_t shape_start = monotonic_ns();
  hb_shape(font, buffer, NULL, 0);
  uint64_t shape_end = monotonic_ns();
  if (!hb_buffer_allocation_successful(buffer)) {
    hb_buffer_destroy(buffer);
    hb_font_destroy(font);
    hb_face_destroy(face);
    hb_blob_destroy(font_blob);
    return fail("HarfBuzz buffer allocation failed");
  }

  unsigned shaped_count = 0;
  hb_glyph_info_t *infos = hb_buffer_get_glyph_infos(buffer, &shaped_count);
  hb_codepoint_t *unique_glyphs = calloc(shaped_count == 0 ? 1 : shaped_count, sizeof(*unique_glyphs));
  if (unique_glyphs == NULL) {
    hb_buffer_destroy(buffer);
    hb_font_destroy(font);
    hb_face_destroy(face);
    hb_blob_destroy(font_blob);
    return fail("unique glyph allocation failed");
  }
  unsigned unique_count = 0;
  for (unsigned index = 0; index < shaped_count; index++) {
    hb_codepoint_t glyph = infos[index].codepoint;
    if (!contains_glyph(unique_glyphs, unique_count, glyph)) unique_glyphs[unique_count++] = glyph;
  }
  qsort(unique_glyphs, unique_count, sizeof(*unique_glyphs), compare_codepoints);

  glyph_sample_t *samples = calloc(unique_count == 0 ? 1 : unique_count, sizeof(*samples));
  hb_codepoint_t *draw_failure_glyphs =
      calloc(unique_count == 0 ? 1 : unique_count, sizeof(*draw_failure_glyphs));
  hb_codepoint_t *encode_failure_glyphs =
      calloc(unique_count == 0 ? 1 : unique_count, sizeof(*encode_failure_glyphs));
  hb_gpu_draw_t *draw = hb_gpu_draw_create_or_fail();
  if (samples == NULL || draw_failure_glyphs == NULL || encode_failure_glyphs == NULL ||
      draw == NULL) {
    free_samples(samples, unique_count);
    free(draw_failure_glyphs);
    free(encode_failure_glyphs);
    free(unique_glyphs);
    hb_gpu_draw_destroy(draw);
    hb_buffer_destroy(buffer);
    hb_font_destroy(font);
    hb_face_destroy(face);
    hb_blob_destroy(font_blob);
    return fail("GPU encoder allocation failed");
  }

  unsigned draw_failure_count = 0;
  unsigned draw_failure_glyph_count = 0;
  unsigned encode_failure_count = 0;
  unsigned encode_failure_glyph_count = 0;
  unsigned mismatch_count = 0;
  for (unsigned glyph_index = 0; glyph_index < unique_count; glyph_index++) {
    glyph_sample_t *sample = &samples[glyph_index];
    sample->glyph_id = unique_glyphs[glyph_index];
    uint64_t elapsed = 0;
    bool glyph_draw_failed = false;
    bool glyph_encode_failed = false;

    for (unsigned iteration = 0; iteration < iterations; iteration++) {
      uint64_t encode_start = monotonic_ns();
      bool draw_succeeded = hb_gpu_draw_glyph_or_fail(draw, font, sample->glyph_id);
      hb_glyph_extents_t extents = {0};
      hb_blob_t *encoded = hb_gpu_draw_encode(draw, &extents);
      uint64_t encode_end = monotonic_ns();
      elapsed += encode_end - encode_start;

      if (!draw_succeeded) {
        draw_failure_count++;
        glyph_draw_failed = true;
      }
      if (iteration == 0) {
        sample->draw_succeeded = draw_succeeded;
        sample->extents = extents;
      } else if (draw_succeeded != sample->draw_succeeded ||
                 memcmp(&sample->extents, &extents, sizeof(extents)) != 0) {
        mismatch_count++;
      }

      if (encoded == NULL) {
        encode_failure_count++;
        glyph_encode_failed = true;
        continue;
      }

      unsigned blob_bytes = 0;
      const char *blob_data = hb_blob_get_data(encoded, &blob_bytes);
      if (iteration == 0) {
        sample->blob_bytes = blob_bytes;
        if (blob_bytes > 0) {
          sample->blob_data = malloc(blob_bytes);
          if (sample->blob_data == NULL) {
            hb_blob_destroy(encoded);
            free_samples(samples, unique_count);
            free(draw_failure_glyphs);
            free(encode_failure_glyphs);
            free(unique_glyphs);
            hb_gpu_draw_destroy(draw);
            hb_buffer_destroy(buffer);
            hb_font_destroy(font);
            hb_face_destroy(face);
            hb_blob_destroy(font_blob);
            return fail("encoded blob copy allocation failed");
          }
          memcpy(sample->blob_data, blob_data, blob_bytes);
        }
      } else if (blob_bytes != sample->blob_bytes ||
                 (blob_bytes > 0 && memcmp(sample->blob_data, blob_data, blob_bytes) != 0)) {
        mismatch_count++;
      }
      hb_gpu_draw_recycle_blob(draw, encoded);
    }

    sample->encode_ns = elapsed / iterations;
    if (glyph_draw_failed) draw_failure_glyphs[draw_failure_glyph_count++] = sample->glyph_id;
    if (glyph_encode_failed)
      encode_failure_glyphs[encode_failure_glyph_count++] = sample->glyph_id;
  }

  const char *shared_vertex =
      hb_gpu_shader_source(HB_GPU_SHADER_STAGE_VERTEX, HB_GPU_SHADER_LANG_WGSL);
  const char *shared_fragment =
      hb_gpu_shader_source(HB_GPU_SHADER_STAGE_FRAGMENT, HB_GPU_SHADER_LANG_WGSL);
  const char *draw_vertex =
      hb_gpu_draw_shader_source(HB_GPU_SHADER_STAGE_VERTEX, HB_GPU_SHADER_LANG_WGSL);
  const char *draw_fragment =
      hb_gpu_draw_shader_source(HB_GPU_SHADER_STAGE_FRAGMENT, HB_GPU_SHADER_LANG_WGSL);

  printf("{\"harfbuzzVersion\":\"%s\",", hb_version_string());
  printf("\"shapeNs\":%" PRIu64 ",", shape_end - shape_start);
  printf("\"shapedGlyphIds\":[");
  for (unsigned index = 0; index < shaped_count; index++) {
    if (index > 0) putchar(',');
    printf("%u", infos[index].codepoint);
  }
  printf("],\"encodeIterations\":%u,", iterations);
  printf("\"drawFailureCount\":%u,", draw_failure_count);
  printf("\"drawFailureGlyphIds\":[");
  for (unsigned index = 0; index < draw_failure_glyph_count; index++) {
    if (index > 0) putchar(',');
    printf("%u", draw_failure_glyphs[index]);
  }
  printf("],\"encodeFailureCount\":%u,", encode_failure_count);
  printf("\"encodeFailureGlyphIds\":[");
  for (unsigned index = 0; index < encode_failure_glyph_count; index++) {
    if (index > 0) putchar(',');
    printf("%u", encode_failure_glyphs[index]);
  }
  printf("],\"blobMismatchCount\":%u,", mismatch_count);
  printf("\"shaderSourceBytes\":{");
  printf("\"sharedVertex\":%zu,", source_bytes(shared_vertex));
  printf("\"sharedFragment\":%zu,", source_bytes(shared_fragment));
  printf("\"drawVertex\":%zu,", source_bytes(draw_vertex));
  printf("\"drawFragment\":%zu},", source_bytes(draw_fragment));
  printf("\"shaderSources\":{");
  printf("\"sharedVertex\":");
  print_json_string(shared_vertex);
  printf(",\"sharedFragment\":");
  print_json_string(shared_fragment);
  printf(",\"drawVertex\":");
  print_json_string(draw_vertex);
  printf(",\"drawFragment\":");
  print_json_string(draw_fragment);
  printf("},");
  printf("\"glyphs\":[");
  for (unsigned index = 0; index < unique_count; index++) {
    glyph_sample_t *sample = &samples[index];
    if (index > 0) putchar(',');
    printf("{\"glyphId\":%u,\"blobBytes\":%u,\"encodeNs\":%" PRIu64
           ",\"blobHex\":\"",
           sample->glyph_id, sample->blob_bytes, sample->encode_ns);
    print_hex(sample->blob_data, sample->blob_bytes);
    printf("\",\"extents\":{");
    printf("\"xBearing\":%d,", sample->extents.x_bearing);
    printf("\"yBearing\":%d,", sample->extents.y_bearing);
    printf("\"width\":%d,", sample->extents.width);
    printf("\"height\":%d}}", sample->extents.height);
  }
  printf("]}\n");

  free_samples(samples, unique_count);
  free(draw_failure_glyphs);
  free(encode_failure_glyphs);
  free(unique_glyphs);
  hb_gpu_draw_destroy(draw);
  hb_buffer_destroy(buffer);
  hb_font_destroy(font);
  hb_face_destroy(face);
  hb_blob_destroy(font_blob);
  return 0;
}
