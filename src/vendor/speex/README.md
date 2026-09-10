# vendor/speex.min.js — 来源与再构建

libspeex **1.2.1**（Xiph.Org，**BSD 许可**，源码 https://downloads.xiph.org/releases/speex/speex-1.2.1.tar.gz）
经 **emscripten** 编译的单文件 wasm（`SINGLE_FILE=1` 将 wasm 以 base64 内嵌 js）。
本项目按 BSD 要求在此保留 Xiph 许可声明：

> Copyright (C) 2002-2007 Jean-Marc Valin
> Copyright (C) 2005-2007 Xiph.Org Foundation
>
> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions
> are met:
>
> - Redistributions of source code must retain the above copyright
>   notice, this list of conditions and the following disclaimer.
>
> - Redistributions in binary form must reproduce the above copyright
>   notice, this list of conditions and the following disclaimer in the
>   documentation and/or other materials provided with the distribution.
>
> - Neither the name of the Xiph.Org Foundation nor the names of its
>   contributors may be used to endorse or promote products derived from
>   this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
> ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
> LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
> A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE FOUNDATION
> OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
> SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
> LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
> DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
> THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
> (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
> OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

emscripten 运行时胶水部分为 **MIT**（Emscripten Authors）。本目录产物无其他来源代码。

## 再构建（Docker，无需本机工具链）

```bash
# 1. 下载源码并解压到临时目录（.cache 已 gitignore）
curl -o .cache/speex-build/speex-1.2.1.tar.gz \
  https://downloads.xiph.org/releases/speex/speex-1.2.1.tar.gz
tar -xzf .cache/speex-build/speex-1.2.1.tar.gz -C .cache/speex-build

# 2. 容器内构建（build.sh：emconfigure → emmake → emcc）
docker run --rm -v "${PWD}/.cache/speex-build:/src" -w /src \
  emscripten/emsdk:latest bash /src/build.sh

# 3. 产物落地
cp .cache/speex-build/out/speex.js src/main/services/dictionary/vendor/speex.min.js
```

build.sh 关键参数：`MODULARIZE=1` + `EXPORT_NAME=SpeexFactory` + `SINGLE_FILE=1` +
`ENVIRONMENT=web`（剥掉 node 分支，规避 Node24 vm 对 `__dirname` 的模块格式探测；
沙箱只需 `window` 真值垫片）+ `ALLOW_MEMORY_GROWTH=1`；
`EXPORTED_FUNCTIONS` 仅导出解码所需 API：`_malloc/_free/_speex_bits_init/
_speex_bits_destroy/_speex_bits_read_from/_speex_decoder_init/_speex_decoder_destroy/
_speex_decoder_ctl/_speex_decode_int/_speex_lib_get_mode`。
