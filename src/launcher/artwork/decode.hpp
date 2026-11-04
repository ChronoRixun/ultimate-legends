#pragma once
#include "store.hpp"
#include <Windows.h>
#include <wincodec.h>
#include <atlbase.h>
#include <vector>
#include <cstdint>
#pragma comment(lib, "Windowscodecs.lib")
#pragma comment(lib, "Ole32.lib")
namespace artwork {
    // WIC is part of Windows. Decode every pixel, not merely the header. Bound expansion
    // to 16 million pixels (64 MB RGBA). WebP is normalized to PNG by CEF before saving.
    inline bool decodes(std::string& bytes) {
        if (image_type(bytes).empty()) return false;
        if (image_type(bytes) == "jpg" && !bytes.ends_with(std::string_view("\xff\xd9", 2))) return false;
        const auto init = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        struct uninit { bool needed; ~uninit() { if (needed) CoUninitialize(); } } com{SUCCEEDED(init)};
        CComPtr<IWICImagingFactory> factory;
        CComPtr<IWICStream> stream;
        CComPtr<IWICBitmapDecoder> decoder;
        CComPtr<IWICBitmapFrameDecode> frame;
        CComPtr<IWICFormatConverter> converter;
        if (FAILED(factory.CoCreateInstance(CLSID_WICImagingFactory)) ||
            FAILED(factory->CreateStream(&stream)) ||
            FAILED(stream->InitializeFromMemory(reinterpret_cast<BYTE*>(bytes.data()), static_cast<DWORD>(bytes.size()))) ||
            FAILED(factory->CreateDecoderFromStream(stream, nullptr, WICDecodeMetadataCacheOnLoad, &decoder)) ||
            FAILED(decoder->GetFrame(0, &frame))) return false;
        GUID container{};
        if (FAILED(decoder->GetContainerFormat(&container))) return false;
        const auto type = image_type(bytes);
        if ((type == "png" && container != GUID_ContainerFormatPng) ||
            (type == "jpg" && container != GUID_ContainerFormatJpeg)) return false;
        UINT width = 0, height = 0;
        if (FAILED(frame->GetSize(&width, &height)) || !width || !height ||
            static_cast<uint64_t>(width) * height > 16'000'000) return false;
        if (FAILED(factory->CreateFormatConverter(&converter)) ||
            FAILED(converter->Initialize(frame, GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone,
                nullptr, 0, WICBitmapPaletteTypeCustom))) return false;
        std::vector<BYTE> pixels(static_cast<size_t>(width) * height * 4);
        return SUCCEEDED(converter->CopyPixels(nullptr, width * 4, static_cast<UINT>(pixels.size()), pixels.data()));
    }

}
