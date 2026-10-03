miniz = {
	source = path.join(dependencies.basePath, "miniz"),
	config = path.join(dependencies.basePath, "miniz-config"),
}

function miniz.import()
	links {
		"miniz"
	}

	miniz.includes()
end

function miniz.includes()
	includedirs {
		miniz.source,
		miniz.config,
	}

	defines {
		"MINIZ_NO_ZLIB_COMPATIBLE_NAMES",
	}
end

function miniz.project()
	project "miniz"
		language "C"

		miniz.includes()

		files {
			path.join(miniz.source, "miniz.c"),
			path.join(miniz.source, "miniz_tdef.c"),
			path.join(miniz.source, "miniz_tinfl.c"),
			path.join(miniz.source, "miniz_zip.c"),
		}

		defines {
			"_LIB"
		}

		removedefines {
			"_DLL",
			"_USRDLL"
		}

		warnings "Off"
		kind "StaticLib"
end

table.insert(dependencies, miniz)
