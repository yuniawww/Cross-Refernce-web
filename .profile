# CF runs this before npm start. Keep browser caches and font links in disposable tmp/.
if [ -n "${VCAP_APPLICATION:-}" ]; then
    export XDG_CACHE_HOME="$PWD/tmp/cache"
    export XDG_CONFIG_HOME="$PWD/tmp/config"
    export XDG_DATA_HOME="$PWD/tmp/data"
    mkdir -p "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME/fonts"
    # apt-buildpack extracts fonts into its dependency layer instead of /usr/share/fonts.
    crawler_fonts_dir="${DEPS_DIR:-/home/vcap/deps}/0/apt/usr/share/fonts"
    if [ -d "$crawler_fonts_dir" ] && [ ! -e "$XDG_DATA_HOME/fonts/apt" ]; then
        ln -s "$crawler_fonts_dir" "$XDG_DATA_HOME/fonts/apt"
    fi
    unset crawler_fonts_dir
fi
