if [[ -n ${SSH_TTY:-} && ${TERM:-} == "xterm-ghostty" ]]; then
  export COLORTERM="truecolor"
fi
