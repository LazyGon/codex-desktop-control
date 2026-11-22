function Test-ClaudeSessionCommand([string]$CommandLine,[string]$Session) {
    if($Session -eq 'Conversation'){
        return $CommandLine -match '(?:^|\s)--resume(?:=|\s+)"?5467c555-7279-5b55-b8ce-e262b1e2e1f7"?(?:\s|$)'
    }
    return $CommandLine -match '(?:^|\s)--name(?:=|\s+)"?雑談Haiku"?(?:\s|$)'
}
