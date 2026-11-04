libtommath = {
	source = path.join(dependencies.basePath, "libtommath"),
}

function libtommath.import()
	links {
		"libtommath"
	}

	libtommath.includes()
end

function libtommath.includes()
	includedirs {
		libtommath.source
	}

	if os.istarget("windows") then
		defines {
			"MP_NO_DEV_URANDOM",
		}
	end

	defines {
		"LTM_DESC",
		"__STDC_IEC_559__",
	}
end

function libtommath.project()
	project "libtommath"
		language "C"

		libtommath.includes()

		files {
			path.join(libtommath.source, "*.c"),
		}

		defines {
			"_LIB"
		}

		removedefines {
			"_DLL",
			"_USRDLL"
		}

		linkoptions {
			"-IGNORE:4221"
		}

        -- MP_HAS uses dead-code elimination for platform selection. /Od leaves
        -- references to unavailable RNG providers (see s_mp_rand_platform.c).
        filter "configurations:Debug"
            optimize "On"
            runtime "Debug"
        filter "configurations:Release"
            -- /GL defers elimination until link, when the unavailable provider
            -- symbols have already become unresolved references.
            removebuildoptions {"/GL"}
            removelinkoptions {"/LTCG"}
        filter {}

		warnings "Off"
		kind "StaticLib"
end

table.insert(dependencies, libtommath)
