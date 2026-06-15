require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'PhotoLibrary'
  s.version = package['version']
  s.summary = 'Capacitor plugin for iOS Photo Library access'
  s.license = 'MIT'
  s.homepage = 'https://github.com/sergiofjr71/Mural'
  s.author = 'Mural'
  s.source = { :git => 'https://github.com/sergiofjr71/Mural.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '14.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
