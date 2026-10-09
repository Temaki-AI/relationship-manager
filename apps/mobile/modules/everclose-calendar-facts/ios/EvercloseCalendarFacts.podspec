Pod::Spec.new do |s|
  s.name = 'EvercloseCalendarFacts'
  s.version = '1.0.0'
  s.summary = 'Minimal EventKit facts for reviewed Everclose plans'
  s.description = s.summary
  s.license = { :type => 'UNLICENSED' }
  s.author = 'Everclose'
  s.homepage = 'https://everclosecrm.com'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => 'https://github.com/Temaki-AI/relationship-manager.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'EventKit'
  s.source_files = '**/*.swift'
end
